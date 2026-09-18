/**
 * 设置区与委派提示测试(此前零覆盖)。
 *
 * 锁死的行为:
 * - 三个开关函数默认开启、显式关闭生效、settings 服务缺失按默认;
 * - agyTest 走真实 CLI 调用形态:proxy 透传三个环境变量、成功取回复文本、
 *   进程 error 归因;
 * - agyInstalled 以 spawnSync 的 error 判定;
 * - registerAgySettings 的模型探测三分支:status(安装/登录)、models
 *   (解析两列、跳过 Fetching 行、空输出回落默认)、test(真实回复);
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

const {
  agyInstalled, agyTest, readImageAgyEnabled, registerAgySettings, searchOverrideEnabled,
} = await import('../src/settings.ts')
const { delegationGuideEnabled, installDelegationGuide } = await import('../src/delegate-guide.ts')

/** 假 ctx:settings.get 由参数决定。 */
function settingsCtx(value: Record<string, unknown> | undefined): Context {
  return {
    get: (key: string) => (key === 'settings'
      ? { get: (ns: string) => (ns === 'agy' ? value : undefined) }
      : undefined),
  } as unknown as Context
}

/** 假 AGY 进程:输出 text 后以 code 收尾。 */
function cliProc(text: string, code = 0): EventEmitter & Record<string, unknown> {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
  proc.stdout = Readable.from([text])
  proc.stderr = undefined
  proc.kill = vi.fn()
  setTimeout(() => proc.emit('close', code), 5)
  return proc
}

describe('settings:开关默认值与显式关闭', () => {
  it('settings 服务缺失时三个开关都按默认开启', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(readImageAgyEnabled(ctx)).toBe(true)
    expect(searchOverrideEnabled(ctx)).toBe(true)
    expect(delegationGuideEnabled(ctx)).toBe(true)
  })

  it('显式关闭后返回 false', () => {
    const ctx = settingsCtx({ readImageAgy: false, searchOverride: false, delegationGuide: false })
    expect(readImageAgyEnabled(ctx)).toBe(false)
    expect(searchOverrideEnabled(ctx)).toBe(false)
    expect(delegationGuideEnabled(ctx)).toBe(false)
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

/** 捕获 discovery 注册的假 ctx:inject 直接触发,llm 捕获 registerModelDiscovery。 */
function discoveryHarness(section: Record<string, unknown>): {
  ctx: Context
  discover: (request: { provider?: string }) => Promise<readonly { id: string; name?: string }[]>
} {
  let discover: ((request: { provider?: string }) => Promise<readonly { id: string; name?: string }[]>) | undefined
  const ctx = {
    get: (key: string) => (key === 'llm'
      ? { registerModelDiscovery: (_ns: string, fn: typeof discover) => { discover = fn } }
      : undefined),
    inject: (deps: string[], fn: (injected: Context) => void) => {
      fn({
        get: (k: string) => (k === 'settings'
          ? {
              installSection: (_owner: unknown, _ns: string, _schema: unknown, _entry: unknown, hooks: { setSource: (s: () => Record<string, unknown>) => void }) => {
                hooks.setSource(() => section)
              },
            }
          : undefined),
      } as unknown as Context)
    },
  } as unknown as Context
  return { ctx, discover: (request) => discover!(request) }
}

describe('settings:模型探测通道', () => {
  it('status:已安装/未登录输出,命令取设置面板的值', async () => {
    mockedSpawnSync.mockReturnValue({ error: undefined } as never)
    const { ctx, discover } = discoveryHarness({ command: 'my-agy' })
    registerAgySettings(ctx)
    const entries = await discover({ provider: 'status' })
    expect(entries[0]?.id).toBe('agy-status')
    expect(entries[0]?.name).toContain('已安装')
    expect(entries[0]?.name).toContain('my-agy')
  })

  it('models:解析两列、跳过 Fetching 行;空输出回落当前默认模型', async () => {
    const { ctx, discover } = discoveryHarness({ command: 'agy', model: 'gemini-3.7-flash-high' })
    registerAgySettings(ctx)

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
    const { ctx, discover } = discoveryHarness({ command: 'agy' })
    registerAgySettings(ctx)
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
      inject: () => {},
    } as unknown as Context
    expect(() => registerAgySettings(ctx)).not.toThrow()
  })
})

describe('delegate-guide:委派提示 section', () => {
  it('注册 agy:tool-policy section(order 0),内容含并行与不轮询要求', () => {
    let section: { name?: string; order?: number; text?: string } | undefined
    const ctx = {
      get: (key: string) => (key === 'settings' ? { get: () => ({}) } : key === 'systemPrompt'
        ? { section: (s: typeof section) => { section = s; return () => {} } }
        : undefined),
    } as unknown as Context
    installDelegationGuide(ctx)
    expect(section?.name).toBe('agy:tool-policy')
    expect(section?.order).toBe(0)
    expect(section?.text).toContain('subagent_agy_ui')
    expect(section?.text).toContain('in parallel')
    expect(section?.text).toContain('Do not poll')
  })

  it('开关关闭时不注入', () => {
    let called = false
    const ctx = {
      get: (key: string) => (key === 'settings' ? { get: () => ({ delegationGuide: false }) } : key === 'systemPrompt'
        ? { section: () => { called = true; return () => {} } }
        : undefined),
    } as unknown as Context
    installDelegationGuide(ctx)
    expect(called).toBe(false)
  })
})
