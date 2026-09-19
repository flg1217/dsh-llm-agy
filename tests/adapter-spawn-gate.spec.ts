/**
 * spawn 门测试:新进程的"写 mcp_config + spawn"要等上一个进程 init——
 * AGY 的全局配置只有一个 dsh 条目,两会话并发首启时后写者会覆盖先启动进程
 * 尚未读到的 URL(工具打到对方会话)。门开在 init 后、首个不阻塞、进程退出
 * 立即放行、3s 兜底。
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AgyLlmAdapter } from '../src/adapter.ts'
import { ConversationStore } from '../src/conversations.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

/** 假 AGY 进程:测试 push 行;stdin 收集;手动 exit。 */
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
  proc.pid = 7301
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

/** spawn 分流:agy → 顺序取假进程;taskkill → 哑对象。 */
function routeProcs(...procs: FakeProc[]): void {
  let index = 0
  mockedSpawn.mockImplementation(((cmd: string) => {
    if (cmd === 'taskkill') return { on: vi.fn() }
    const proc = procs[index]
    index += 1
    return proc
  }) as unknown as typeof spawn)
}

/** 实际 spawn 次数(排除 taskkill)。 */
function spawnCount(): number {
  return mockedSpawn.mock.calls.filter(call => call[0] !== 'taskkill').length
}

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const session = {
  header: { cwd: process.cwd(), id: 'sess-gate' },
  ownEvents: () => [],
  append: () => ({ seq: 1 }),
}
const ctx = {
  get: (key: string) => (key === 'sessions' ? { get: () => session } : undefined),
} as unknown as Context

function makeAdapter(): AgyLlmAdapter {
  return new AgyLlmAdapter(ctx, {
    command: 'agy', model: 'gemini-3.1-pro-high', effort: 'high', extraArgs: [],
    maxAttempts: 1, retryDelayMs: 30,
    store: new ConversationStore(null),
    // 门与 executor 部署无关:关掉以免写真实 ~/.gemini(测试隔离)。
    dshExecutor: () => false,
  })
}

function optionsFor(sessionId: string): GenerateOptions {
  return {
    provider: 'agy',
    model: 'gemini-3.1-pro-high',
    sessionId,
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '干活' }], source: { kind: 'user' } }],
  } as unknown as GenerateOptions
}

async function consume(adapter: AgyLlmAdapter, sessionId: string): Promise<void> {
  for await (const _chunk of adapter.stream(optionsFor(sessionId))) { /* 只驱动门 */ }
}

const initLine = (conv: string): string => JSON.stringify({ event: 'init', conversation_id: conv })
const resultLine = (): string =>
  JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } })

beforeEach(() => { mockedSpawn.mockReset() })

describe('spawn 门:并发首启串行化', () => {
  it('第二个会话的 spawn 要等第一个进程 init', async () => {
    const a = agyProc()
    const b = agyProc()
    routeProcs(a, b)
    const adapter = makeAdapter()
    const runA = consume(adapter, 'sess-a')
    await waitFor(() => a.stdinWrites.length >= 1)

    const runB = consume(adapter, 'sess-b')
    // B 已进 acquire,但 A 未 init → B 不得 spawn。
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(spawnCount()).toBe(1)

    // A init → 门开 → B spawn。
    a.pushLine(initLine('conv-a'))
    await waitFor(() => spawnCount() === 2)

    b.pushLine(initLine('conv-b'))
    a.pushLine(resultLine())
    b.pushLine(resultLine())
    await Promise.allSettled([runA, runB])
  })

  it('进程 init 前退出:门立即放行,不空等 3s 兜底', async () => {
    const a = agyProc()
    const b = agyProc()
    routeProcs(a, b)
    const adapter = makeAdapter()
    const runA = consume(adapter, 'sess-a')
    await waitFor(() => a.stdinWrites.length >= 1)

    a.exitNow(1) // 未 init 即死(静默失败重建场景)
    const started = Date.now()
    const runB = consume(adapter, 'sess-b')
    await waitFor(() => spawnCount() === 2, 1_500)
    expect(Date.now() - started).toBeLessThan(1_500)

    b.pushLine(initLine('conv-b'))
    b.pushLine(resultLine())
    await Promise.allSettled([runA, runB])
  })

  it('同会话并发(两次 stream 重叠):过门后二次查表复用,不双开进程', async () => {
    const x = agyProc()
    const a = agyProc()
    routeProcs(x, a)
    const adapter = makeAdapter()
    // X 占住门(未 init)。
    const runX = consume(adapter, 'sess-x')
    await waitFor(() => x.stdinWrites.length >= 1)

    // A、B(同会话)都排在门后。
    const runA = consume(adapter, 'same')
    const runB = consume(adapter, 'same')
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(spawnCount()).toBe(1)

    // 门开:A 过门建进程;B 过门时命中二次查表 → 复用(不 spawn)。
    x.pushLine(initLine('conv-x'))
    x.pushLine(resultLine())
    await waitFor(() => spawnCount() === 2)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(spawnCount()).toBe(2)

    // 只验证 spawn 次数:同会话双 stream 共享同一进程,收尾语义非本用例目标
    // (真实 loop 一个会话同时只有一个 stream),fire-and-forget 让测试收口。
    void runX; void runA; void runB
  })
})
