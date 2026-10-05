/**
 * 设置区与委派提示测试(此前零覆盖)。
 *
 * 锁死的行为(0.2.1 volatile 模型:Config schema 即设置表单):
 * - Config schema 默认值:命令/模型/代理有默认、三个开关默认开启;
 *   显式关闭/覆盖生效;
 * - agyTest 走真实 CLI 调用形态:proxy 透传三个环境变量、成功取回复文本、
 *   进程 error 归因;
 * - agyInstalled 以 spawnSync 的 error 判定;
 * - registerAgySettings 的模型探测三分支:status(安装/登录)、models
 *   (解析两列、跳过 Fetching 行、空输出回落默认)、test(真实回复);
 *   命令/代理/模型从活引用实时读;
 * - DUPLICATE_DISCOVERY 不抛(多 realm apply 场景);
 * - 委派提示 section 注册与开关(关闭时不注入)。
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(), spawnSync: vi.fn() }
})
const { spawn, spawnSync } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)
const mockedSpawnSync = vi.mocked(spawnSync)

beforeEach(() => {
  mockedSpawn.mockReset()
  mockedSpawnSync.mockReset()
})

const { agyInstalled, agyTest, registerAgySettings } = await import('../src/settings.ts')
const { Config } = await import('../src/index.ts')
const { installDelegationGuide } = await import('../src/delegate-guide.ts')

/** 假 AGY 进程:输出 text 后以 code 收尾。 */
function cliProc(text: string, code = 0): EventEmitter & Record<string, unknown> {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
  proc.stdout = Readable.from([text])
  proc.stderr = undefined
  proc.kill = vi.fn()
  setTimeout(() => proc.emit('close', code), 5)
  return proc
}

describe('settings:Config schema 默认值与显式覆盖', () => {
  it('缺省:命令/模型/代理有默认,三个开关默认开启', () => {
    const config = Config({})
    expect(config.command.get()).toBe('agy')
    expect(config.model.get()).toBe('gemini-3.7-flash-high')
    expect(config.effort.get()).toBe('high')
    expect(config.proxy.get()).toBe('http://127.0.0.1:7890')
    expect(config.readImageAgy.get()).toBe(true)
    expect(config.searchOverride.get()).toBe(true)
    expect(config.delegationGuide.get()).toBe(true)
    expect(config.dshExecutor.get()).toBe(true)
  })

  it('显式关闭/覆盖后活引用读到新值', () => {
    const config = Config({
      command: 'my-agy',
      readImageAgy: false,
      searchOverride: false,
      delegationGuide: false,
    })
    expect(config.command.get()).toBe('my-agy')
    expect(config.readImageAgy.get()).toBe(false)
    expect(config.searchOverride.get()).toBe(false)
    expect(config.delegationGuide.get()).toBe(false)
  })
})

describe('settings:agyTest / agyInstalled', () => {
  it('agyTest 取真实回复文本,proxy 透传三个环境变量', async () => {
    mockedSpawn.mockImplementation((() => cliProc(' 我是 AGY \n')) as unknown as typeof spawn)
    const { ok, output } = await agyTest('agy', 'http://127.0.0.1:7890')
    expect(ok).toBe(true)
    expect(output).toBe('我是 AGY')
    const env = (mockedSpawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }).env
    expect(env?.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env?.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(env?.ALL_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('agyTest 无代理时不覆盖环境变量;进程 error 归因到 output', async () => {
    mockedSpawn.mockImplementation((() => cliProc('hi')) as unknown as typeof spawn)
    await agyTest('agy', '')
    // 无代理:原样透传当前环境(不注入/不删除已有变量)。
    expect((mockedSpawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }).env?.HTTPS_PROXY)
      .toBe(process.env.HTTPS_PROXY)

    const failing = new EventEmitter() as EventEmitter & Record<string, unknown>
    failing.stdout = Readable.from([])
    failing.stderr = undefined
    failing.kill = vi.fn()
    mockedSpawn.mockImplementation((() => failing) as unknown as typeof spawn)
    const promise = agyTest('agy', '')
    setTimeout(() => failing.emit('error', new Error('ENOENT')), 5)
    const { ok, output } = await promise
    expect(ok).toBe(false)
    expect(output).toContain('ENOENT')
  })

  it('agyInstalled:spawnSync 无 error 视为已安装', () => {
    mockedSpawnSync.mockReturnValue({ error: undefined } as never)
    expect(agyInstalled('agy')).toBe(true)
    mockedSpawnSync.mockReturnValue({ error: new Error('ENOENT') } as never)
    expect(agyInstalled('agy')).toBe(false)
  })
})

/** 捕获 discovery 注册的假 ctx:llm 捕获 registerModelDiscovery;settings 用 Config 构造。 */
function discoveryHarness(input: Record<string, unknown>): {
  ctx: Context
  discover: (request: { provider?: string }) => Promise<readonly { id: string; name?: string }[]>
} {
  let discover: ((request: { provider?: string }) => Promise<readonly { id: string; name?: string }[]>) | undefined
  const ctx = {
    get: (key: string) => (key === 'llm'
      ? { registerModelDiscovery: (_ns: string, fn: typeof discover) => { discover = fn } }
      : undefined),
  } as unknown as Context
  registerAgySettings(ctx, Config(input))
  return { ctx, discover: (request) => discover!(request) }
}

describe('settings:模型探测通道', () => {
  it('status:已安装/未登录输出,命令取活引用的值', async () => {
    mockedSpawnSync.mockReturnValue({ error: undefined } as never)
    const { discover } = discoveryHarness({ command: 'my-agy' })
    const entries = await discover({ provider: 'status' })
    expect(entries[0]?.id).toBe('agy-status')
    expect(entries[0]?.name).toContain('已安装')
    expect(entries[0]?.name).toContain('my-agy')
  })

  it('models:解析两列、跳过 Fetching 行;空输出回落当前默认模型', async () => {
    const { discover } = discoveryHarness({ command: 'agy', model: 'gemini-3.7-flash-high' })

    mockedSpawnSync.mockReturnValue({
      stdout: 'Fetching models...\ngemini-3.8-high  Gemini 3.8 High\nclaude-4-opus  Claude 4 Opus\n',
      stderr: '',
    } as never)
    const entries = await discover({ provider: 'models' })
    expect(entries.map(e => e.id)).toEqual(['gemini-3.8-high', 'claude-4-opus'])
    expect(entries[0]?.name).toContain('Gemini 3.8 High')

    mockedSpawnSync.mockReturnValue({ stdout: '', stderr: '' } as never)
    const fallback = await discover({ provider: 'models' })
    expect(fallback).toEqual([{ id: 'gemini-3.7-flash-high', name: 'gemini-3.7-flash-high' }])
  })

  it('test:成功展示真实回复,失败带 ✗ 前缀', async () => {
    mockedSpawn.mockImplementation((() => cliProc('你好,我是 AGY')) as unknown as typeof spawn)
    const { discover } = discoveryHarness({ command: 'agy' })
    const ok = await discover({ provider: 'test' })
    expect(ok[0]?.name).toBe('你好,我是 AGY')

    mockedSpawn.mockImplementation((() => cliProc('', 1)) as unknown as typeof spawn)
    const failed = await discover({ provider: 'test' })
    expect(failed[0]?.name).toContain('✗ AGY 测试失败')
  })

  it('DUPLICATE_DISCOVERY(多 realm apply)被吞掉,不向上抛', () => {
    const ctx = {
      get: (key: string) => (key === 'llm'
        ? { registerModelDiscovery: () => { const e = new Error('dup'); (e as { code?: string }).code = 'DUPLICATE_DISCOVERY'; throw e } }
        : undefined),
    } as unknown as Context
    expect(() => registerAgySettings(ctx, Config({}))).not.toThrow()
  })
})

describe('delegate-guide:委派提示 section', () => {
  it('注册 agy:tool-policy section(order 0),内容含并行与不轮询要求', () => {
    let section: { name?: string; order?: number; text?: string } | undefined
    const ctx = {
      get: (key: string) => (key === 'systemPrompt'
        ? { section: (s: typeof section) => { section = s; return () => {} } }
        : undefined),
    } as unknown as Context
    installDelegationGuide(ctx, true)
    expect(section?.name).toBe('agy:tool-policy')
    expect(section?.order).toBe(0)
    expect(section?.text).toContain('subagent_agy_ui')
    expect(section?.text).toContain('in parallel')
    expect(section?.text).toContain('Do not poll')
  })

  it('开关关闭时不注入', () => {
    let called = false
    const ctx = {
      get: (key: string) => (key === 'systemPrompt'
        ? { section: () => { called = true; return () => {} } }
        : undefined),
    } as unknown as Context
    installDelegationGuide(ctx, false)
    expect(called).toBe(false)
  })
})
