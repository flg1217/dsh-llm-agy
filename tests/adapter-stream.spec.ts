/**
 * 适配器流处理链路回归测试(工具事件去重/错误归因/重试与卡死判定)。
 *
 * 锁死的行为:
 * - 同一 stepIndex 的多次 ACTIVE 只落一条 tool/call(AGY 参数流式补全,
 *   重复落地会毒死前端事件订阅流——实测窗口全白);
 * - DONE/ERROR 无配对 call 或重复到达时忽略(不产生幽灵 tool/result);
 * - ERROR 状态:isError 置位、错误文本优先取 tool_info.error 兜底;
 * - 静默零输出退出(code 0 无行)= 非法的空回答,合成 retryable 走重试;
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

/**
 * 假进程:pushLine 逐行喂 stdout;kill 时立刻以 code 1 收尾(不再等真进程),
 * 使 stall/abort 路径的 closeWithTimeout 立即返回。
 */
function agyProc(): EventEmitter & Record<string, unknown> & { pushLine: (line: string) => void; end: () => void } {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown> & { pushLine: (line: string) => void; end: () => void }
  proc.stdout = new Readable({ read(): void { /* 测试 push 驱动 */ } })
  proc.stderr = undefined
  proc.pid = 7001
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = vi.fn(() => {
    if (proc.exitCode === null) {
      proc.exitCode = 1
      proc.emit('exit', 1, null)
      proc.emit('close', 1, null)
    }
  })
  proc.pushLine = (line: string) => { (proc.stdout as Readable).push(`${line}\n`) }
  proc.end = (code = 0) => {
    ;(proc.stdout as Readable).push(null)
    setTimeout(() => {
      proc.exitCode = code
      proc.emit('exit', code, null)
      proc.emit('close', code, null)
    }, 5)
  }
  return proc
}

/** 把 spawn:agy 与内部 taskkill 分流(杀进程树不会误伤脚本进程)。 */
function routeProc(proc: EventEmitter & Record<string, unknown>): void {
  mockedSpawn.mockImplementation(((cmd: string) => {
    if (cmd === 'taskkill') return { on: vi.fn() }
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
    messages: [{ role: 'user', content: [{ type: 'text', text: '干活' }] }],
  } as unknown as GenerateOptions
}

async function collect(adapter: AgyLlmAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options())) chunks.push(chunk)
  return chunks
}

function stepLine(state: string, toolName: string, stepIndex: number, toolInfo: unknown): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: {
      step_type: 'tool', state, step_index: stepIndex, tool_name: toolName, tool_info: toolInfo,
    },
  })
}

const okResult = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } })

beforeEach(() => {
  appended.length = 0
  mockedSpawn.mockReset()
  mockedExecFile.mockReset()
})

describe('适配器:工具步骤事件落地', () => {
  it('同一 stepIndex 的多次 ACTIVE 只落一条 tool/call(参数流式补全不重复)', async () => {
    const proc = agyProc()
    routeProc(proc)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    proc.pushLine(stepLine('ACTIVE', 'run_command', 1, { parameters: {} }))
    proc.pushLine(stepLine('ACTIVE', 'run_command', 1, { parameters: { CommandLine: 'ls' } }))
    proc.pushLine(stepLine('DONE', 'run_command', 1, { output: 'ok' }))
    proc.pushLine(okResult)
    proc.end()
    await consume

    expect(appended.filter(e => e.type === 'tool/call')).toHaveLength(1)
    expect(appended.filter(e => e.type === 'tool/result')).toHaveLength(1)
  })

  it('DONE 无配对 call / 重复 DONE 都被忽略(不产生幽灵 tool/result)', async () => {
    const proc = agyProc()
    routeProc(proc)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    proc.pushLine(stepLine('DONE', 'run_command', 9, { output: '无配对' }))
    proc.pushLine(stepLine('ACTIVE', 'run_command', 1, { parameters: { CommandLine: 'ls' } }))
    proc.pushLine(stepLine('DONE', 'run_command', 1, { output: 'ok' }))
    proc.pushLine(stepLine('DONE', 'run_command', 1, { output: '重复' }))
    proc.pushLine(okResult)
    proc.end()
    await consume

    expect(appended.filter(e => e.type === 'tool/result')).toHaveLength(1)
  })

  it('ERROR 状态:isError 置位,输出为空时取 tool_info.error 作错误文本', async () => {
    const proc = agyProc()
    routeProc(proc)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    proc.pushLine(stepLine('ACTIVE', 'run_command', 2, { parameters: { CommandLine: 'false' } }))
    proc.pushLine(stepLine('ERROR', 'run_command', 2, { error: 'command failed: exit 1' }))
    proc.pushLine(okResult)
    proc.end()
    await consume

    const result = appended.find(e => e.type === 'tool/result')?.data as {
      message?: { content?: readonly { isError?: boolean; content?: readonly { text?: string }[] }[] }
    }
    expect(result?.message?.content?.[0]?.isError).toBe(true)
    expect(result?.message?.content?.[0]?.content?.[0]?.text).toContain('command failed: exit 1')
  })

  it('usage 事件按增量透传(含 cache_read 与 thinking)', async () => {
    const proc = agyProc()
    routeProc(proc)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    proc.pushLine(JSON.stringify({
      event: 'step_update',
      step_update: {
        text_delta: 'x',
        usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2, thinking_tokens: 1 },
      },
    }))
    proc.pushLine(okResult)
    proc.end()
    const chunks = await consume

    const usage = chunks.find(c => c.type === 'usage') as { usage?: Record<string, number> } | undefined
    expect(usage?.usage).toMatchObject({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 1 })
  })
})

describe('适配器:错误归因与重试', () => {
  it('静默零输出退出(code 0)= 非法空回答:合成 retryable,重试一次后成功', async () => {
    const first = agyProc()
    const second = agyProc()
    mockedSpawn.mockImplementationOnce((() => first) as unknown as typeof spawn)
    mockedSpawn.mockImplementationOnce((() => second) as unknown as typeof spawn)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    first.end(0) // 零输出正常退出
    // 等重试的第二个进程起来(重试间隔 30ms)。
    await new Promise(resolve => setTimeout(resolve, 80))
    second.pushLine(okResult)
    second.end(0)
    const chunks = await consume

    expect(mockedSpawn).toHaveBeenCalledTimes(2)
    // 零输出没建立会话:重试不带 --conversation。
    expect(mockedSpawn.mock.calls[1]?.[1]).not.toContain('--conversation')
    expect(chunks.some(c => c.type === 'finish')).toBe(true)
  })

  it('上下文超限:不重试,以错误收尾并附最近执行步骤反馈', async () => {
    const proc = agyProc()
    routeProc(proc)
    const adapter = makeAdapter()
    const consume = collect(adapter)
    proc.pushLine(stepLine('ACTIVE', 'run_command', 1, { parameters: { CommandLine: 'x' } }))
    proc.pushLine(JSON.stringify({
      event: 'result',
      result: { status: 'ERROR', error: 'the prompt exceeds the maximum context window length' },
    }))
    proc.end(1)
    const chunks = await consume

    expect(mockedSpawn).toHaveBeenCalledTimes(1) // context 超限不重试
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
    // taskkill 也是一次 spawn:必须按命令分流,不能让杀进程树消耗掉脚本进程。
    const agyProcs = [first, second]
    let agyCall = 0
    mockedSpawn.mockImplementation(((cmd: string) => {
      if (cmd === 'taskkill') return { on: vi.fn() }
      return agyProcs[agyCall++]
    }) as unknown as typeof spawn)
    const adapter = makeAdapter({
      // 快速到点:一行采样后预算 40ms。
      timeouts: { firstMs: 5_000, idleMinMs: 30, idleMaxMs: 40, idleFactor: 3, idleWarmupLines: 1 },
    })
    const consume = collect(adapter)
    first.pushLine(JSON.stringify({ event: 'init', init: { conversation_id: 'c-stall' } }))
    // 保持静默 → 空闲超时 → 判死。
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(first.kill).toHaveBeenCalled()
    second.pushLine(okResult)
    second.end(0)
    const chunks = await consume

    expect(agyCall).toBe(2)
    // stall 是 retryable:重试带 --conversation 续跑同一会话。
    const agyCalls = mockedSpawn.mock.calls.filter(call => call[0] === 'agy')
    expect(agyCalls).toHaveLength(2)
    expect(agyCalls[1]?.[1]).toContain('--conversation')
    expect(chunks.some(c => c.type === 'finish')).toBe(true)
  })
})
