/**
 * 适配器流处理链路回归测试(工具事件去重/错误归因/重试与卡死判定)。
 *
 * 架构:常驻进程(--input-format stream-json),每轮写一行 stdin 消息、
 * 读事件到该轮 result。fake 进程支持 stdin 写入收集(断言发送内容)与
 * 手动 push 事件;测试在 push 前等 stdin 写入(active 轮已建立)。
 *
 * 锁死的行为:
 * - 同一 stepIndex 的多次 ACTIVE 只落一条 tool/call(参数流式补全);
 * - DONE/ERROR 无配对 call 或重复到达时忽略;
 * - ERROR 状态:isError 置位、错误文本优先取 tool_info.error 兜底;
 * - 进程静默退出(零输出)与空 result 轮 = 非法空回答,合成 retryable 重试;
 * - 上下文超限:不重试、以错误收尾,并附最近执行步骤反馈;
 * - 空闲超时到点且 AGY 无活跃子进程 → 杀进程树、按 retryable 重试;
 * - usage 事件按增量透传。
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyLlmAdapter } from '../src/adapter.ts'
import { ConversationStore } from '../src/conversations.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(), execFile: vi.fn() }
})
const { execFile, spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)
const mockedExecFile = vi.mocked(execFile)

/** 假 AGY 常驻进程(stdin 收集;stdout 测试 push;手动 exitNow)。 */
interface FakeProc extends EventEmitter {
  stdout: Readable
  stderr: Readable
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  stdinWrites: string[]
  pid: number
  exitCode: number | null
  signalCode: string | null
  kill: ReturnType<typeof vi.fn>
  pushLine: (line: string) => void
  exitNow: (code?: number) => void
}

function agyProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  const stdinWrites: string[] = []
  proc.stdout = new Readable({ read(): void { /* push 驱动 */ } })
  proc.stderr = new Readable({ read(): void { /* 无输出 */ } })
  proc.stdinWrites = stdinWrites
  proc.stdin = {
    write: vi.fn((chunk: string) => { stdinWrites.push(chunk); return true }),
    end: vi.fn(),
  }
  proc.pid = 7001
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = vi.fn()
  proc.pushLine = (line: string) => { proc.stdout.push(`${line}\n`) }
  proc.exitNow = (code = 0) => {
    if (proc.exitCode === null) {
      proc.exitCode = code
      proc.emit('exit', code, null)
    }
  }
  return proc
}

/** spawn 分流:agy → 顺序取假进程;taskkill(进程树杀)→ 哑对象。 */
function routeProcs(...procs: FakeProc[]): void {
  let index = 0
  mockedSpawn.mockImplementation(((cmd: string) => {
    if (cmd === 'taskkill') return { on: vi.fn() }
    const proc = procs[index]
    index += 1
    return proc
  }) as unknown as typeof spawn)
}

const appended: Array<{ type: string; data: unknown }> = []
const session = {
  header: { cwd: process.cwd(), id: 'sess-stream' },
  ownEvents: () => [],
  append: (type: string, data: unknown) => {
    appended.push({ type, data })
    return { seq: appended.length }
  },
}
const ctx = {
  get: (key: string) => (key === 'sessions' ? { get: () => session } : undefined),
} as unknown as Context

function makeAdapter(overrides?: Record<string, unknown>): AgyLlmAdapter {
  return new AgyLlmAdapter(ctx, {
    command: 'agy', model: 'gemini-3.1-pro-high', effort: 'high', extraArgs: [],
    maxAttempts: 2, retryDelayMs: 30,
    store: new ConversationStore(null),
    ...overrides,
  })
}

function options(): GenerateOptions {
  return {
    provider: 'agy',
    model: 'gemini-3.1-pro-high',
    sessionId: 'sess-stream',
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '干活' }], source: { kind: 'user' } }],
  } as unknown as GenerateOptions
}

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function collect(adapter: AgyLlmAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options())) chunks.push(chunk)
  return chunks
}

/** 发一行用户消息的 JSON 协议形状。 */
const resultLine = (status: string, body: Record<string, unknown>): string =>
  JSON.stringify({ event: 'result', result: { status, ...body } })

function stepLine(state: string, toolName: string, stepIndex: number, toolInfo: unknown): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: {
      step_type: 'tool', state, step_index: stepIndex, tool_name: toolName, tool_info: toolInfo,
    },
  })
}

beforeEach(() => {
  appended.length = 0
  mockedSpawn.mockReset()
  mockedExecFile.mockReset()
})

describe('适配器:工具步骤事件落地', () => {
  it('同一 stepIndex 的多次 ACTIVE 只落一条 tool/call(参数流式补全不重复)', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    await waitFor(() => proc.stdinWrites.length === 1)
    proc.pushLine(stepLine('ACTIVE', 'run_command', 1, { parameters: {} }))
    proc.pushLine(stepLine('ACTIVE', 'run_command', 1, { parameters: { CommandLine: 'ls' } }))
    proc.pushLine(stepLine('DONE', 'run_command', 1, { output: 'ok' }))
    proc.pushLine(resultLine('SUCCESS', { response: 'ok' }))
    await consume

    expect(appended.filter(e => e.type === 'tool/call')).toHaveLength(1)
    expect(appended.filter(e => e.type === 'tool/result')).toHaveLength(1)
  })

  it('DONE 无配对 call / 重复 DONE 都被忽略(不产生幽灵 tool/result)', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    await waitFor(() => proc.stdinWrites.length === 1)
    proc.pushLine(stepLine('DONE', 'run_command', 9, { output: '无配对' }))
    proc.pushLine(stepLine('ACTIVE', 'run_command', 1, { parameters: { CommandLine: 'ls' } }))
    proc.pushLine(stepLine('DONE', 'run_command', 1, { output: 'ok' }))
    proc.pushLine(stepLine('DONE', 'run_command', 1, { output: '重复' }))
    proc.pushLine(resultLine('SUCCESS', { response: 'ok' }))
    await consume

    expect(appended.filter(e => e.type === 'tool/result')).toHaveLength(1)
  })

  it('ERROR 状态:isError 置位,输出为空时取 tool_info.error 作错误文本', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    await waitFor(() => proc.stdinWrites.length === 1)
    proc.pushLine(stepLine('ACTIVE', 'run_command', 2, { parameters: { CommandLine: 'false' } }))
    proc.pushLine(stepLine('ERROR', 'run_command', 2, { error: 'command failed: exit 1' }))
    proc.pushLine(resultLine('SUCCESS', { response: 'ok' }))
    await consume

    const result = appended.find(e => e.type === 'tool/result')?.data as {
      message?: { content?: readonly { isError?: boolean; content?: readonly { text?: string }[] }[] }
    }
    expect(result?.message?.content?.[0]?.isError).toBe(true)
    expect(result?.message?.content?.[0]?.content?.[0]?.text).toContain('command failed: exit 1')
  })

  it('usage 事件按增量透传(含 cache_read 与 thinking)', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    await waitFor(() => proc.stdinWrites.length === 1)
    proc.pushLine(JSON.stringify({
      event: 'step_update',
      step_update: {
        text_delta: 'x',
        usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2, thinking_tokens: 1 },
      },
    }))
    proc.pushLine(resultLine('SUCCESS', { response: 'ok' }))
    const chunks = await consume

    const usage = chunks.find(c => c.type === 'usage') as { usage?: Record<string, number> } | undefined
    expect(usage?.usage).toMatchObject({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 1 })
  })
})

describe('适配器:错误归因与重试', () => {
  it('进程静默退出(零输出):按 retryable 重建进程重试一次后成功', async () => {
    const first = agyProc()
    const second = agyProc()
    routeProcs(first, second)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    await waitFor(() => first.stdinWrites.length === 1)
    first.exitNow(0) // 零输出正常退出
    // 重试(30ms 后)在第二个进程上重发全量(首轮无凭据)。
    await waitFor(() => second.stdinWrites.length === 1)
    expect(JSON.parse(second.stdinWrites[0]!).message.content[0].text).toContain('干活')
    second.pushLine(resultLine('SUCCESS', { response: 'ok' }))
    const chunks = await consume

    expect(mockedSpawn.mock.calls.filter(c => c[0] === 'agy')).toHaveLength(2)
    expect(chunks.some(c => c.type === 'finish')).toBe(true)
  })

  it('空 result 轮(无文本无工具)也按 retryable 重试(复用同进程续跑)', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    await waitFor(() => proc.stdinWrites.length === 1)
    proc.pushLine('{"event":"init","conversation_id":"c1","init":{"model":"m"}}')
    proc.pushLine(resultLine('SUCCESS', {})) // 空轮
    // 进程还活着:重试复用同进程,发续跑提示(有会话 id 就不重发原任务)。
    await waitFor(() => proc.stdinWrites.length === 2)
    expect(JSON.parse(proc.stdinWrites[1]!).message.content[0].text).toContain('继续完成之前未完成的任务')
    proc.pushLine(resultLine('SUCCESS', { response: 'ok' }))
    const chunks = await consume

    expect(mockedSpawn.mock.calls.filter(c => c[0] === 'agy')).toHaveLength(1)
    expect(chunks.some(c => c.type === 'finish')).toBe(true)
  })

  it('上下文超限:不重试,以错误收尾并附最近执行步骤反馈', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    await waitFor(() => proc.stdinWrites.length === 1)
    proc.pushLine(stepLine('ACTIVE', 'run_command', 1, { parameters: { CommandLine: 'x' } }))
    proc.pushLine(stepLine('DONE', 'run_command', 1, { output: 'ok' }))
    proc.pushLine(resultLine('ERROR', { error: 'the prompt exceeds the maximum context window length' }))
    const chunks = await consume

    expect(mockedSpawn.mock.calls.filter(c => c[0] === 'agy')).toHaveLength(1) // context 超限不重试
    const text = chunks
      .filter(c => c.type === 'text-delta')
      .map(c => (c as { text?: string }).text ?? '')
      .join('')
    expect(text).toContain('AGY 子代理执行异常反馈')
    expect(text).toContain('上下文超限')
    expect(text).toContain('run_command')
  })

  it('空闲超时且 AGY 无活跃子进程 → 杀进程树并 retryable 重试', async () => {
    mockedExecFile.mockImplementation(((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => {
      cb(new Error('no powershell'), '')
    }) as unknown as typeof execFile)
    const first = agyProc()
    const second = agyProc()
    routeProcs(first, second)
    const adapter = makeAdapter({
      // 快速到点:一行采样后预算 40ms。
      timeouts: { firstMs: 5_000, idleMinMs: 30, idleMaxMs: 40, idleFactor: 3, idleWarmupLines: 1 },
    })
    const consume = collect(adapter)
    await waitFor(() => first.stdinWrites.length === 1)
    first.pushLine('{"event":"init","conversation_id":"c-stall","init":{"model":"m"}}')
    // 保持静默 → 空闲超时 → 判死。
    await waitFor(() => first.kill.mock.calls.length > 0, 3_000)
    await waitFor(() => second.stdinWrites.length === 1)
    second.pushLine(resultLine('SUCCESS', { response: 'ok' }))
    const chunks = await consume

    expect(mockedSpawn.mock.calls.filter(c => c[0] === 'agy')).toHaveLength(2)
    // stall 重试是"无可恢复凭据的首轮":重发原任务(全量)。
    expect(JSON.parse(second.stdinWrites[0]!).message.content[0].text).toContain('干活')
    expect(chunks.some(c => c.type === 'finish')).toBe(true)
  })
})

describe('适配器:后台任务状态驱动续轮(协议层识别,不靠提示词)', () => {
  it('result 时任务仍 RUNNING → dsh 自动续轮等待;任务终态后正常收尾', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    await waitFor(() => proc.stdinWrites.length === 1)
    // AGY 报告"已启动,稍后汇报",但 manage_task 输出显示任务仍在运行。
    proc.pushLine(stepLine('ACTIVE', 'manage_task', 1, { parameters: { Action: 'status', TaskId: 'c1/task-4' } }))
    proc.pushLine(stepLine('DONE', 'manage_task', 1, {
      output: 'Task: c1/task-4\nStatus: RUNNING\nLog: C:\\x\\task-4.log\nLast progress: never',
    }))
    proc.pushLine(resultLine('SUCCESS', { response: '已启动后台测试,稍后汇报。' }))
    // dsh 侧识别到 RUNNING:自动续发等待指令(同进程、同会话)。
    await waitFor(() => proc.stdinWrites.length === 2)
    const waitText = JSON.parse(proc.stdinWrites[1]!).message.content[0].text as string
    expect(waitText).toContain('仍在运行')
    expect(waitText).toContain('c1/task-4')

    // 第二轮:任务终态 DONE → 正常收尾。
    proc.pushLine(stepLine('ACTIVE', 'manage_task', 2, { parameters: { Action: 'status', TaskId: 'c1/task-4' } }))
    proc.pushLine(stepLine('DONE', 'manage_task', 2, {
      output: 'Task: c1/task-4\nStatus: DONE\nLog: C:\\x\\task-4.log',
    }))
    proc.pushLine(resultLine('SUCCESS', { response: '测试已跑完,全部通过。' }))
    const chunks = await consume

    expect(proc.stdinWrites).toHaveLength(2)
    // result.response 的完整文本在 end() 的 block-end 里(text_delta 可能为空)。
    const text = chunks.map((c) => {
      if (c.type === 'text-delta') return (c as { text?: string }).text ?? ''
      if (c.type === 'block-end') return (c as { block?: { text?: string } }).block?.text ?? ''
      return ''
    }).join('')
    expect(text).toContain('测试已跑完')
    expect(chunks.some(c => c.type === 'finish' && (c as { reason?: { kind?: string } }).reason?.kind === 'stop')).toBe(true)
  })
})
