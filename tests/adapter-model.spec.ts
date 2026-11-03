/**
 * 模型选择回归测试:每轮请求的 `model` 决定 `--model` 启动参数,而不是插件配置
 * 里的默认值;同一会话换模型必须重建进程(启动参数在 spawn 时固定,改不了)。
 *
 * 现场(2026-11-03):子代理传 `model: gemini-3.8-flash-high` / `claude-sonnet-4-6`,
 * 报错里始终是 `--model "gemini-4-argon-medium"`(插件配置值)——请求被忽略,
 * 而这个 id 已不在 `agy models` 列表里,委派直接不可用。
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
const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

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
}

function agyProc(pid: number): FakeProc {
  const proc = new EventEmitter() as FakeProc
  const stdinWrites: string[] = []
  proc.stdout = new Readable({ read(): void { /* push 驱动 */ } })
  proc.stderr = new Readable({ read(): void { /* 无输出 */ } })
  proc.stdinWrites = stdinWrites
  proc.stdin = {
    write: vi.fn((chunk: string) => { stdinWrites.push(chunk); return true }),
    end: vi.fn(),
  }
  proc.pid = pid
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = vi.fn()
  proc.pushLine = (line: string) => { proc.stdout.push(`${line}\n`) }
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

/** agy 进程的启动参数(过滤掉 taskkill,它也算一次 spawn)。 */
function agySpawns(): string[][] {
  return mockedSpawn.mock.calls
    .filter(call => call[0] === 'agy')
    .map(call => (Array.isArray(call[1]) ? call[1] as string[] : []))
}

function modelArg(args: string[]): string | undefined {
  const at = args.indexOf('--model')
  return at < 0 ? undefined : args[at + 1]
}

const session = {
  header: { cwd: process.cwd(), id: 'sess-model' },
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
  })
}

function options(model: string): GenerateOptions {
  return {
    provider: 'agy',
    model,
    sessionId: 'sess-model',
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '干活' }], source: { kind: 'user' } }],
  } as unknown as GenerateOptions
}

/** 起一轮、等本轮 prompt 写入后给终局 result,收尾。 */
async function runTurn(adapter: AgyLlmAdapter, model: string, proc: FakeProc): Promise<StreamChunk[]> {
  const baseline = proc.stdinWrites.length
  const chunks: StreamChunk[] = []
  const consume = (async () => {
    for await (const chunk of adapter.stream(options(model))) chunks.push(chunk)
  })()
  const started = Date.now()
  while (proc.stdinWrites.length === baseline) {
    if (Date.now() - started > 2_000) throw new Error('waitFor 超时')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  proc.pushLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
  await consume
  return chunks
}

/** spawn 门开在进程 init 之后;假进程不自己报到,这里补一行 init 让门放行。 */
async function reportInit(proc: FakeProc): Promise<void> {
  proc.pushLine(JSON.stringify({ event: 'init', conversation_id: 'conv-1' }))
  await new Promise(resolve => setTimeout(resolve, 20))
}

type Acquire = (sessionId: string, cwd: string, prior: string | undefined, model: string) => Promise<{ model: string }>

beforeEach(() => {
  mockedSpawn.mockReset()
})

describe('适配器:模型选择', () => {
  it('--model 取本轮请求的模型,不取插件配置默认值', async () => {
    const proc = agyProc(7101)
    routeProcs(proc)
    await runTurn(makeAdapter(), 'claude-sonnet-4-6', proc)

    expect(agySpawns()).toHaveLength(1)
    expect(modelArg(agySpawns()[0]!)).toBe('claude-sonnet-4-6')
    // 非 Gemini 模型不接受 --effort(AGY 实测:--effort is not supported for model X)
    expect(agySpawns()[0]).not.toContain('--effort')
  })

  it('无强度后缀的 Gemini 模型仍按配置传 --effort', async () => {
    const proc = agyProc(7106)
    routeProcs(proc)
    await runTurn(makeAdapter(), 'gemini-3.1-pro', proc)

    expect(modelArg(agySpawns()[0]!)).toBe('gemini-3.1-pro')
    expect(agySpawns()[0]).toContain('--effort')
  })

  it('模型名自带强度后缀时省略 --effort(AGY 拒绝 --model 与 --effort 并存)', async () => {
    const proc = agyProc(7102)
    routeProcs(proc)
    await runTurn(makeAdapter(), 'gemini-3.8-flash-high', proc)

    expect(modelArg(agySpawns()[0]!)).toBe('gemini-3.8-flash-high')
    expect(agySpawns()[0]).not.toContain('--effort')
  })

  it('同一会话换模型重建进程(旧进程杀掉,新进程带新 --model)', async () => {
    const first = agyProc(7103)
    const second = agyProc(7104)
    routeProcs(first, second)
    const adapter = makeAdapter() as unknown as { acquire: Acquire }
    const a = await adapter.acquire('sess-model', process.cwd(), undefined, 'gemini-3.8-flash-high')
    expect(a.model).toBe('gemini-3.8-flash-high')
    await reportInit(first)

    const b = await adapter.acquire('sess-model', process.cwd(), undefined, 'claude-opus-4-6-thinking')
    expect(b.model).toBe('claude-opus-4-6-thinking')
    expect(agySpawns()).toHaveLength(2)
    expect(modelArg(agySpawns()[1]!)).toBe('claude-opus-4-6-thinking')
    expect(first.kill).toHaveBeenCalled()
    expect(first.stdin.end).toHaveBeenCalled()
  })

  it('同一模型复用常驻进程,不重复 spawn', async () => {
    const proc = agyProc(7105)
    routeProcs(proc)
    const adapter = makeAdapter() as unknown as { acquire: Acquire }

    const a = await adapter.acquire('sess-model', process.cwd(), undefined, 'gemini-3.8-flash-medium')
    await reportInit(proc)
    const b = await adapter.acquire('sess-model', process.cwd(), undefined, 'gemini-3.8-flash-medium')

    expect(b).toBe(a)
    expect(agySpawns()).toHaveLength(1)
  })
})
