/**
 * 适配器续跑(常驻进程 + conversation 记忆 + 增量补发)回归测试。
 *
 * 架构(2026-09-18 实测后切换):每个 dsh 会话一个常驻
 * `agy --input-format stream-json` 进程;stream() 每轮往 stdin 写一行
 * NDJSON 用户消息、读事件到本轮 result。--conversation 只在**进程启动**时
 * 作为参数(续接记录恢复);同进程内多轮天然共享会话(后台任务跨轮存活)。
 *
 * 现场(2026-09-18):子代理被"继续"时全量历史(1.2MB)重发、AGY 先读巨型
 * agy-task 文件;根因之一是 conversation_id 解析取错层级导致 --conversation
 * 从未生效。修复:顶层解析 + 增量补发 + 续接记录持久化 + 常驻进程。
 *
 * 锁死的行为:
 * - 首轮:启动进程不带 --conversation;stdin 消息为全量序列化;
 * - 续跑:复用同一进程(不再 spawn),stdin 只发锚点后的增量;
 * - 锚点丢失(压缩移除):仍复用进程,--conversation 在重建时用,stdin 只发
 *   最后一条用户输入兜底;
 * - 成功收尾才写续接记录;失败保留旧锚点;
 * - 网络错重试:同进程写续跑提示(带运行时约束),成功后锚点推进;
 * - 会话失效:杀常驻进程、不重试、不回退全量;记忆保留(重建时带旧 id);
 * - abort:不写记录,下次调用重建且不带 --conversation。
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyLlmAdapter } from '../src/adapter.ts'
import { ConversationStore } from '../src/conversations.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

/** 假 AGY 常驻进程:stdin 收集写入行;stdout 由测试 push;不自动退出。 */
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
  proc.stderr = new Readable({ read(): void { /* push 驱动 */ } })
  proc.stdinWrites = stdinWrites
  proc.stdin = {
    write: vi.fn((chunk: string) => { stdinWrites.push(chunk); return true }),
    end: vi.fn(),
  }
  proc.pid = 9001
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

/** 一次成功轮的事件行(init 顶层 conversation_id + 文本 + result)。 */
const okLines = (cid: string, text = 'done'): string[] => [
  `{"event":"init","conversation_id":"${cid}","init":{"model":"m"}}`,
  `{"step_update":{"conversation_id":"${cid}","step_type":"agent_response","state":"ACTIVE","text_delta":"${text}"}}`,
  `{"event":"result","conversation_id":"${cid}","result":{"status":"SUCCESS","response":"${text}"}}`,
]

/** 错误 result 行。 */
const errorLine = (error: string): string =>
  `{"event":"result","result":{"status":"ERROR","error":"${error}"}}`

const ctx = { get: (): undefined => undefined } as unknown as Context

function makeAdapter(overrides?: Record<string, unknown>): AgyLlmAdapter {
  return new AgyLlmAdapter(ctx, {
    command: 'agy',
    model: 'gemini-3.1-pro-high',
    effort: 'high',
    extraArgs: [],
    maxAttempts: 3,
    retryDelayMs: 50,
    // 纯内存续接记录:测试不落盘,也不读真实 ~/.dsh/agy/conversations.json。
    store: new ConversationStore(null),
    ...overrides,
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

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** 起一轮 stream 消费(不 await;驱动方按需 push 事件)。 */
function startTurn(adapter: AgyLlmAdapter, sessionId: string, messages: Message[]): Promise<StreamChunk[]> {
  return (async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(opts(sessionId, messages))) chunks.push(chunk)
    return chunks
  })()
}

/** 取 fake proc 收到的第 i 条 stdin 消息(解析后)。 */
function stdinAt(proc: FakeProc, index: number): { event?: string; text: string } {
  const raw = proc.stdinWrites[index] ?? ''
  const parsed = JSON.parse(raw) as { event?: string; message?: { content?: Array<{ text?: string }> } }
  return { event: parsed.event, text: parsed.message?.content?.[0]?.text ?? '' }
}

/** agy 的 spawn 调用(过滤 taskkill)。 */
function agyArgs(index: number): string[] {
  const calls = mockedSpawn.mock.calls.filter(call => call[0] !== 'taskkill')
  return calls[index]?.[1] ?? []
}

beforeEach(() => {
  mockedSpawn.mockReset()
})

describe('常驻进程:首轮与续跑', () => {
  it('首轮:启动进程不带 --conversation,stdin 发全量', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()
    const consume = startTurn(adapter, 's1', [msg('m1', 'user', '第一问')])
    await waitFor(() => proc.stdinWrites.length === 1)
    expect(stdinAt(proc, 0).event).toBe('user')
    expect(stdinAt(proc, 0).text).toContain('第一问')
    for (const line of okLines('c1')) proc.pushLine(line)
    await consume

    expect(mockedSpawn.mock.calls.filter(c => c[0] !== 'taskkill')).toHaveLength(1)
    expect(agyArgs(0)).toContain('--input-format')
    expect(agyArgs(0)).not.toContain('--conversation')
  })

  it('续跑:复用同进程(不再 spawn),stdin 只发锚点后的增量', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()

    const first = startTurn(adapter, 's1', [msg('m1', 'user', '原始任务')])
    await waitFor(() => proc.stdinWrites.length === 1)
    for (const line of okLines('c1')) proc.pushLine(line)
    await first

    const second = startTurn(adapter, 's1', [
      msg('m1', 'user', '原始任务'),
      msg('m2', 'assistant', '我在做'),
      msg('m3', 'user', '继续'),
    ])
    await waitFor(() => proc.stdinWrites.length === 2)
    const resumed = stdinAt(proc, 1)
    expect(resumed.text).toContain('继续')
    expect(resumed.text).not.toContain('原始任务')
    expect(resumed.text).not.toContain('我在做')
    for (const line of okLines('c1')) proc.pushLine(line)
    await second

    // 全程只启动过一次进程(第二轮复用),任务/上下文在同一进程内延续。
    expect(mockedSpawn.mock.calls.filter(c => c[0] !== 'taskkill')).toHaveLength(1)
  })

  it('锚点丢失(压缩移除):复用进程,stdin 只发最后一条用户输入兜底', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()

    const first = startTurn(adapter, 's1', [msg('m1', 'user', '原始任务')])
    await waitFor(() => proc.stdinWrites.length === 1)
    for (const line of okLines('c1')) proc.pushLine(line)
    await first

    const compacted = {
      id: 'c1x',
      role: 'user',
      content: [{ type: 'text', text: '[上下文已压缩]' }],
      source: { kind: 'plugin', plugin: 'compact' },
    } as unknown as Message
    const second = startTurn(adapter, 's1', [compacted, msg('m2', 'user', '继续')])
    await waitFor(() => proc.stdinWrites.length === 2)
    const resumed = stdinAt(proc, 1)
    expect(resumed.text).toContain('继续')
    expect(resumed.text).not.toContain('上下文已压缩')
    expect(resumed.text).not.toContain('原始任务')
    for (const line of okLines('c1')) proc.pushLine(line)
    await second
  })

  it('多轮演进:锚点逐轮推进,每轮 stdin 只带新增量', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()

    const t1 = startTurn(adapter, 's1', [msg('m1', 'user', '第一问')])
    await waitFor(() => proc.stdinWrites.length === 1)
    for (const line of okLines('c1')) proc.pushLine(line)
    await t1

    const t2 = startTurn(adapter, 's1', [
      msg('m1', 'user', '第一问'), msg('m2', 'assistant', '第一答'), msg('m3', 'user', '第二问'),
    ])
    await waitFor(() => proc.stdinWrites.length === 2)
    expect(stdinAt(proc, 1).text).toContain('第二问')
    expect(stdinAt(proc, 1).text).not.toContain('第一问')
    for (const line of okLines('c1')) proc.pushLine(line)
    await t2

    const t3 = startTurn(adapter, 's1', [
      msg('m1', 'user', '第一问'), msg('m2', 'assistant', '第一答'),
      msg('m3', 'user', '第二问'), msg('m4', 'user', '第三问'),
    ])
    await waitFor(() => proc.stdinWrites.length === 3)
    expect(stdinAt(proc, 2).text).toContain('第三问')
    expect(stdinAt(proc, 2).text).not.toContain('第二问')
    for (const line of okLines('c1')) proc.pushLine(line)
    await t3

    expect(mockedSpawn.mock.calls.filter(c => c[0] !== 'taskkill')).toHaveLength(1)
  })

  it('跨重启恢复:新 adapter(同一持久层)启动进程带 --conversation,stdin 发增量', async () => {
    const store = new ConversationStore(null)
    const procA = agyProc()
    const procB = agyProc()
    routeProcs(procA, procB)

    const before = makeAdapter({ store })
    const t1 = startTurn(before, 's1', [msg('m1', 'user', '第一问')])
    await waitFor(() => procA.stdinWrites.length === 1)
    for (const line of okLines('c1')) procA.pushLine(line)
    await t1

    // “重启”:新 adapter 实例,共享同一持久层(真实场景由文件重载)。
    const after = makeAdapter({ store })
    const t2 = startTurn(after, 's1', [
      msg('m1', 'user', '第一问'), msg('m2', 'assistant', '第一答'), msg('m3', 'user', '第二问'),
    ])
    await waitFor(() => procB.stdinWrites.length === 1)

    // 新进程以 --conversation 恢复服务端会话;stdin 只发增量。
    expect(agyArgs(1)).toContain('--conversation')
    expect(agyArgs(1)[agyArgs(1).indexOf('--conversation') + 1]).toBe('c1')
    const resumed = stdinAt(procB, 0)
    expect(resumed.text).toContain('第二问')
    expect(resumed.text).not.toContain('第一问')
    for (const line of okLines('c1')) procB.pushLine(line)
    await t2
  })
})

describe('常驻进程:失败与恢复', () => {
  it('首轮失败:不写记录,下次仍发全量(不是增量,不静默吞消息)', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()

    const t1 = startTurn(adapter, 's1', [msg('m1', 'user', '第一问')])
    await waitFor(() => proc.stdinWrites.length === 1)
    proc.pushLine('{"event":"init","conversation_id":"c1","init":{"model":"m"}}')
    proc.pushLine(errorLine('boom')) // 非 retryable:不重试
    await t1

    // 失败未写记录:下次调用(进程还活着,复用)发全量。
    const t2 = startTurn(adapter, 's1', [msg('m1', 'user', '第一问'), msg('m2', 'user', '继续')])
    await waitFor(() => proc.stdinWrites.length === 2)
    const second = stdinAt(proc, 1)
    expect(second.text).toContain('第一问')
    expect(second.text).toContain('继续')
    for (const line of okLines('c1')) proc.pushLine(line)
    await t2
  })

  it('网络错重试:同进程写续跑提示(带运行时约束),成功后锚点推进', async () => {
    const proc = agyProc()
    routeProcs(proc)
    const adapter = makeAdapter()

    const t1 = startTurn(adapter, 's1', [msg('m1', 'user', '第一问')])
    await waitFor(() => proc.stdinWrites.length === 1)
    proc.pushLine('{"event":"init","conversation_id":"c1","init":{"model":"m"}}')
    proc.pushLine(errorLine('network issue'))
    // attempt 2:同进程,stdin 第二条为续跑提示。
    await waitFor(() => proc.stdinWrites.length === 2)
    const retry = stdinAt(proc, 1)
    expect(retry.text).toContain('继续完成之前未完成的任务')
    expect(retry.text).toContain('运行环境约束') // 约束随行
    expect(retry.text).not.toContain('第一问')   // 不重发原任务
    for (const line of okLines('c1')) proc.pushLine(line)
    await t1

    // 重试成功后锚点推进到 m1:下一轮是增量。
    const t2 = startTurn(adapter, 's1', [msg('m1', 'user', '第一问'), msg('m2', 'user', '继续')])
    await waitFor(() => proc.stdinWrites.length === 3)
    const next = stdinAt(proc, 2)
    expect(next.text).toContain('继续')
    expect(next.text).not.toContain('第一问')
    for (const line of okLines('c1')) proc.pushLine(line)
    await t2

    expect(mockedSpawn.mock.calls.filter(c => c[0] !== 'taskkill')).toHaveLength(1)
  })

  it('会话失效:杀常驻进程、不重试不回退;记忆保留(重建时带旧 id)', async () => {
    const procA = agyProc()
    const procB = agyProc()
    routeProcs(procA, procB)
    const adapter = makeAdapter()

    const t1 = startTurn(adapter, 's1', [msg('m1', 'user', '原始任务')])
    await waitFor(() => procA.stdinWrites.length === 1)
    for (const line of okLines('c1')) procA.pushLine(line)
    await t1

    const t2 = startTurn(adapter, 's1', [
      msg('m1', 'user', '原始任务'), msg('m2', 'assistant', '我在做'), msg('m3', 'user', '继续'),
    ])
    await waitFor(() => procA.stdinWrites.length === 2)
    procA.pushLine(errorLine('conversation not found or expired'))
    const chunks = await t2
    // 不重试:stdin 没有第三条(attempt 2)。
    expect(procA.stdinWrites).toHaveLength(2)
    expect(procA.kill).toHaveBeenCalled()
    const finish = chunks.find(chunk => chunk.type === 'finish') as { reason?: { failure?: { message?: string } } } | undefined
    expect(finish?.reason?.failure?.message).toContain('conversation')

    // 记忆保留:下次调用重建进程,启动参数仍带旧会话 id(报错一致性,
    // 不静默降级全量空会话)。
    const t3 = startTurn(adapter, 's1', [msg('m1', 'user', '原始任务'), msg('m3', 'user', '再试一次')])
    await waitFor(() => procB.stdinWrites.length === 1)
    expect(agyArgs(1)).toContain('--conversation')
    expect(agyArgs(1)[agyArgs(1).indexOf('--conversation') + 1]).toBe('c1')
    for (const line of okLines('c1')) procB.pushLine(line)
    await t3
  })

  it('abort:不写记录,下次调用重建且不带 --conversation', async () => {
    const procA = agyProc()
    const procB = agyProc()
    routeProcs(procA, procB)
    const adapter = makeAdapter()

    const controller = new AbortController()
    const consume = (async () => {
      const chunks: StreamChunk[] = []
      const stream = adapter.stream({ ...opts('s1', [msg('m1', 'user', '第一问')]), signal: controller.signal } as GenerateOptions)
      for await (const chunk of stream) chunks.push(chunk)
      return chunks
    })()
    await waitFor(() => procA.stdinWrites.length === 1)
    procA.pushLine('{"event":"init","conversation_id":"c1","init":{"model":"m"}}')
    controller.abort()
    await consume
    expect(procA.kill).toHaveBeenCalled()

    // 记录未写:下次调用重建进程,不带 --conversation。
    const t2 = startTurn(adapter, 's1', [msg('m1', 'user', '第一问')])
    await waitFor(() => procB.stdinWrites.length === 1)
    expect(agyArgs(1)).toContain('--input-format')
    expect(agyArgs(1)).not.toContain('--conversation')
    for (const line of okLines('c1')) procB.pushLine(line)
    await t2
  })
})
