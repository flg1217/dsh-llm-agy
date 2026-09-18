/**
 * 适配器续跑(conversation 记忆 + 增量补发)回归测试。
 *
 * 现场(2026-09-18):子代理被"继续"时适配器把全量历史(System instructions +
 * 全部消息)重新序列化发给 AGY——AGY conversation 已有上下文,重发既产生
 * 巨量 token 开销,又被 AGY 当作新任务从头重跑(重读任务文件、重新 Glob)。
 *
 * 修复:续接记录(conversationId + 主锚 lastSentMessageId + 数量锚 sentCount)
 * 按 dsh 会话持久化在适配器内,续跑走 resumeReplayPrompt 只补发增量。
 *
 * 锁死的行为:
 * - 首轮无记忆:spawn 不带 --conversation,发全量;
 * - 续跑:带 --conversation,只补发锚点后的增量(AGY 自己的轮次不重发);
 * - 成功收尾才写续接记录(主锚=最后一条消息 id);
 * - 锚点丢失(压缩移除):仍带 --conversation,只发最后一条用户输入兜底;
 * - AGY 报会话失效:不重试、不回退全量,直接以错误 finish 收尾;记忆保留。
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyLlmAdapter } from '../src/adapter.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

/** 假 AGY 进程:stdout 按脚本逐行输出后 EOF,随后 exit。 */
function agyProc(lines: string[], exitCode = 0): EventEmitter & Record<string, unknown> {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
  const stdout = new Readable({ read(): void { /* push 驱动 */ } })
  proc.stdout = stdout
  proc.stderr = new Readable({ read(): void { /* push 驱动 */ } })
  proc.pid = 4242
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = vi.fn()
  setTimeout(() => {
    for (const line of lines) stdout.push(`${line}\n`)
    stdout.push(null)
    setTimeout(() => {
      proc.exitCode = exitCode
      proc.emit('exit', exitCode)
      proc.emit('close', exitCode)
    }, 1)
  }, 1)
  return proc
}

/** 一次成功回合的 stream-json 行(init 带会话 id)。 */
const okLines = (cid: string): string[] => [
  `{"event":"init","init":{"conversation_id":"${cid}"}}`,
  '{"step_update":{"text_delta":"done"}}',
  `{"event":"result","result":{"status":"SUCCESS","response":"done text"}}`,
]

const ctx = { get: (): undefined => undefined } as unknown as Context

function makeAdapter(): AgyLlmAdapter {
  return new AgyLlmAdapter(ctx, {
    command: 'agy',
    model: 'gemini-3.1-pro-high',
    effort: 'high',
    extraArgs: [],
    maxAttempts: 3,
    retryDelayMs: 50,
  })
}

/** 带 id 与来源的消息(user 为真实用户输入;assistant 默认 agy 自己的轮次)。 */
function msg(id: string, role: 'user' | 'assistant', text: string, provider = 'agy'): Message {
  return {
    id,
    role,
    content: [{ type: 'text', text }],
    source: role === 'user'
      ? { kind: 'user' }
      : { kind: 'model', provider, model: 'x' },
  } as unknown as Message
}

function opts(sessionId: string, messages: Message[]): GenerateOptions {
  return {
    provider: 'agy',
    model: 'gemini-3.1-pro-high',
    sessionId,
    messages,
  } as unknown as GenerateOptions
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 第 i 次 spawn 的参数(args 数组)。 */
function argsOf(index: number): string[] {
  return mockedSpawn.mock.calls[index]?.[1] ?? []
}

describe('AgyLlmAdapter:续跑增量补发(--conversation 记忆)', () => {
  beforeEach(() => {
    mockedSpawn.mockReset()
  })

  it('首轮无记忆:不带 --conversation,发全量', async () => {
    mockedSpawn.mockImplementation(() => agyProc(okLines('c1')) as unknown as ReturnType<typeof spawn>)
    const adapter = makeAdapter()
    await collect(adapter.stream(opts('s1', [msg('m1', 'user', '原始任务')])))
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
    expect(argsOf(0)).not.toContain('--conversation')
    expect(argsOf(0)[argsOf(0).indexOf('-p') + 1]).toContain('原始任务')
  })

  it('续跑:带 --conversation,只补发增量(原任务与 own 轮不重发)', async () => {
    mockedSpawn.mockImplementation(() => agyProc(okLines('c1')) as unknown as ReturnType<typeof spawn>)
    const adapter = makeAdapter()
    await collect(adapter.stream(opts('s1', [msg('m1', 'user', '原始任务')])))

    mockedSpawn.mockImplementation(() => agyProc(okLines('c1')) as unknown as ReturnType<typeof spawn>)
    await collect(adapter.stream(opts('s1', [
      msg('m1', 'user', '原始任务'),
      msg('m2', 'assistant', '我在做'),
      msg('m3', 'user', '继续'),
    ])))

    const args = argsOf(1)
    const conversation = args.indexOf('--conversation')
    expect(conversation).toBeGreaterThanOrEqual(0)
    expect(args[conversation + 1]).toBe('c1')
    const prompt = args[args.indexOf('-p') + 1]
    expect(prompt).toContain('继续')
    expect(prompt).not.toContain('原始任务')
    expect(prompt).not.toContain('我在做')
  })

  it('锚点丢失(压缩移除):仍带 --conversation,只发最后一条用户输入兜底', async () => {
    mockedSpawn.mockImplementation(() => agyProc(okLines('c1')) as unknown as ReturnType<typeof spawn>)
    const adapter = makeAdapter()
    await collect(adapter.stream(opts('s1', [msg('m1', 'user', '原始任务')])))

    mockedSpawn.mockImplementation(() => agyProc(okLines('c1')) as unknown as ReturnType<typeof spawn>)
    const compacted = {
      id: 'c1x',
      role: 'user',
      content: [{ type: 'text', text: '[上下文已压缩]' }],
      source: { kind: 'plugin', plugin: 'compact' },
    } as unknown as Message
    await collect(adapter.stream(opts('s1', [compacted, msg('m2', 'user', '继续')])))

    const args = argsOf(1)
    expect(args).toContain('--conversation')
    const prompt = args[args.indexOf('-p') + 1]
    expect(prompt).toContain('继续')
    expect(prompt).not.toContain('上下文已压缩')
    expect(prompt).not.toContain('原始任务')
  })

  it('AGY 报会话失效:不重试不回退,直接以错误收尾,记忆保留', async () => {
    mockedSpawn.mockImplementation(() => agyProc(okLines('c1')) as unknown as ReturnType<typeof spawn>)
    const adapter = makeAdapter()
    await collect(adapter.stream(opts('s1', [msg('m1', 'user', '原始任务')])))

    mockedSpawn.mockImplementation(() => agyProc([
      '{"event":"result","result":{"status":"ERROR","error":"conversation not found or expired"}}',
    ]) as unknown as ReturnType<typeof spawn>)
    const chunks = await collect(adapter.stream(opts('s1', [
      msg('m1', 'user', '原始任务'),
      msg('m2', 'assistant', '我在做'),
      msg('m3', 'user', '继续'),
    ])))

    // 不重试:本次调用只 spawn 一次。
    expect(mockedSpawn).toHaveBeenCalledTimes(2)
    const finish = chunks.find(chunk => chunk.type === 'finish') as { reason?: { failure?: { message?: string } } } | undefined
    expect(finish?.reason?.failure?.message).toContain('conversation')

    // 记忆保留:下一次续跑仍带 --conversation(报错一致性,不静默降级全量)。
    mockedSpawn.mockImplementation(() => agyProc([
      '{"event":"result","result":{"status":"ERROR","error":"conversation not found"}}',
    ]) as unknown as ReturnType<typeof spawn>)
    await collect(adapter.stream(opts('s1', [
      msg('m1', 'user', '原始任务'),
      msg('m3', 'user', '再试一次'),
    ])))
    expect(mockedSpawn).toHaveBeenCalledTimes(3)
    expect(argsOf(2)).toContain('--conversation')
  })

  it('多轮演进:锚点逐轮推进,每轮只发新增量;会话 id 更新被记住', async () => {
    mockedSpawn.mockImplementation(() => agyProc(okLines('c1')) as unknown as ReturnType<typeof spawn>)
    const adapter = makeAdapter()
    await collect(adapter.stream(opts('s1', [msg('m1', 'user', '第一问')])))
    expect(argsOf(0)).not.toContain('--conversation')

    // 第二轮:AGY 恢复后 init 返回新的会话 id(c2)——记录应更新为 c2。
    mockedSpawn.mockImplementation(() => agyProc(okLines('c2')) as unknown as ReturnType<typeof spawn>)
    await collect(adapter.stream(opts('s1', [
      msg('m1', 'user', '第一问'),
      msg('m2', 'assistant', '第一答'),
      msg('m3', 'user', '第二问'),
    ])))
    {
      const args = argsOf(1)
      expect(args[args.indexOf('--conversation') + 1]).toBe('c1')
      const prompt = args[args.indexOf('-p') + 1]
      expect(prompt).toContain('第二问')
      expect(prompt).not.toContain('第一问')
      expect(prompt).not.toContain('第一答')
    }

    // 第三轮:锚点已推进到 m3,只发 m4;会话 id 已是 c2。
    mockedSpawn.mockImplementation(() => agyProc(okLines('c2')) as unknown as ReturnType<typeof spawn>)
    await collect(adapter.stream(opts('s1', [
      msg('m1', 'user', '第一问'),
      msg('m2', 'assistant', '第一答'),
      msg('m3', 'user', '第二问'),
      msg('m4', 'user', '第三问'),
    ])))
    {
      const args = argsOf(2)
      expect(args[args.indexOf('--conversation') + 1]).toBe('c2')
      const prompt = args[args.indexOf('-p') + 1]
      expect(prompt).toContain('第三问')
      expect(prompt).not.toContain('第二问')
    }
  })

  it('首轮失败:不写记录,下次仍发全量(不是增量,不静默吞消息)', async () => {
    mockedSpawn.mockImplementation(() => agyProc([
      '{"event":"init","init":{"conversation_id":"c1"}}',
      '{"event":"result","result":{"status":"ERROR","error":"boom"}}',
    ], 1) as unknown as ReturnType<typeof spawn>)
    const adapter = makeAdapter()
    await collect(adapter.stream(opts('s1', [msg('m1', 'user', '第一问')])))
    expect(mockedSpawn).toHaveBeenCalledTimes(1) // "boom" 非 retryable,不重试

    // 失败未写记录:下次调用无 --conversation 且发全量(含第一问)。
    mockedSpawn.mockImplementation(() => agyProc(okLines('c1')) as unknown as ReturnType<typeof spawn>)
    await collect(adapter.stream(opts('s1', [
      msg('m1', 'user', '第一问'),
      msg('m2', 'user', '继续'),
    ])))
    const args = argsOf(1)
    expect(args).not.toContain('--conversation')
    const prompt = args[args.indexOf('-p') + 1]
    expect(prompt).toContain('第一问')
    expect(prompt).toContain('继续')
  })

  it('网络错重试:同会话续跑(--conversation + 续跑提示带约束),成功后锚点推进', async () => {
    mockedSpawn.mockImplementationOnce(() => agyProc([
      '{"event":"init","init":{"conversation_id":"c1"}}',
      '{"event":"result","result":{"status":"ERROR","error":"network issue"}}',
    ], 1) as unknown as ReturnType<typeof spawn>)
    mockedSpawn.mockImplementationOnce(() => agyProc(okLines('c1')) as unknown as ReturnType<typeof spawn>)
    const adapter = makeAdapter()
    await collect(adapter.stream(opts('s1', [msg('m1', 'user', '第一问')])))

    expect(mockedSpawn).toHaveBeenCalledTimes(2)
    {
      const args = argsOf(1)
      expect(args[args.indexOf('--conversation') + 1]).toBe('c1')
      const prompt = args[args.indexOf('-p') + 1]
      expect(prompt).toContain('继续完成之前未完成的任务')
      expect(prompt).toContain('运行环境约束') // 约束随行
      expect(prompt).not.toContain('第一问')   // 不重发原任务
    }

    // 重试成功后锚点推进到 m1:第三轮是增量。
    mockedSpawn.mockImplementation(() => agyProc(okLines('c1')) as unknown as ReturnType<typeof spawn>)
    await collect(adapter.stream(opts('s1', [
      msg('m1', 'user', '第一问'),
      msg('m2', 'user', '继续'),
    ])))
    const args = argsOf(2)
    expect(args).toContain('--conversation')
    const prompt = args[args.indexOf('-p') + 1]
    expect(prompt).toContain('继续')
    expect(prompt).not.toContain('第一问')
  })

  it('abort:即使已拿到会话 id 也不写记录,下次调用仍全量', async () => {
    /** init 已到但 stdout 永不 EOF(模拟残留子进程持有写端)。 */
    const stuckProc = (): EventEmitter & Record<string, unknown> => {
      const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
      const stdout = new Readable({ read(): void { /* 永不产出/EOOF */ } })
      stdout.push('{"event":"init","init":{"conversation_id":"c1"}}\n')
      proc.stdout = stdout
      proc.stderr = undefined
      proc.pid = 4242
      proc.exitCode = null
      proc.signalCode = null
      proc.kill = vi.fn()
      return proc
    }
    mockedSpawn.mockImplementation(() => stuckProc() as unknown as ReturnType<typeof spawn>)
    const adapter = makeAdapter()
    const controller = new AbortController()
    const consume = collect(adapter.stream({ ...opts('s1', [msg('m1', 'user', '第一问')]), signal: controller.signal } as GenerateOptions))
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    await consume

    // 记录未写:下次调用无 --conversation(全量重发)。
    mockedSpawn.mockImplementation(() => agyProc(okLines('c1')) as unknown as ReturnType<typeof spawn>)
    await collect(adapter.stream(opts('s1', [msg('m1', 'user', '第一问')])))
    expect(argsOf(1)).not.toContain('--conversation')
  })
})
