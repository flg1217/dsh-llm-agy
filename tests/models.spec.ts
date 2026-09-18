/**
 * 模型查询(list_agy_models)的代理透传回归测试。
 *
 * 现场(2026-09-18):`list_agy_models` 没走设置面板配置的代理——工具用的是
 * 同步实现(spawnSync 硬编码、不设 env),而设置面板路由的异步查询带
 * proxy env。修复后两者共用异步查询,proxy/command 由 getter 实时读设置。
 *
 * 锁死的行为:
 * - 查询进程收到 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 三个环境变量;
 * - 无代理时不覆盖 env(避免把 process.env 序列化成空对象);
 * - 设置面板改代理后工具**立即**生效(无需重启);
 * - stderr 只留尾部 3 行(诊断"没网/没代理"),失败时输出给主代理。
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { listAgyModelEntriesAsync, registerAgyModelsTool } from '../src/models.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

/** 下一次 spawn 的假进程脚本。 */
let nextProc: { stdout?: string; stderr?: string } = {}

/** 假 AGY 进程:按脚本推 stdout/stderr 后 EOF + close。 */
function fakeProc(script: { stdout?: string; stderr?: string }): unknown {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
  const stdout = new Readable({ read(): void { /* push 驱动 */ } })
  const stderr = new Readable({ read(): void { /* push 驱动 */ } })
  proc.stdout = stdout
  proc.stderr = stderr
  proc.kill = vi.fn()
  setTimeout(() => {
    if (script.stdout !== undefined) stdout.push(script.stdout)
    if (script.stderr !== undefined) stderr.push(script.stderr)
    stdout.push(null)
    stderr.push(null)
    setTimeout(() => proc.emit('close', 0), 1)
  }, 1)
  return proc
}

/** 最近一次 spawn 的 options.env。 */
function lastEnv(): NodeJS.ProcessEnv | undefined {
  const call = mockedSpawn.mock.calls.at(-1)
  return (call?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env
}

/** 捕获注册的工具定义。 */
function harness(): { ctx: Context; tool: () => Record<string, unknown> } {
  let registered: Record<string, unknown> | undefined
  const ctx = {
    tools: { register: (definition: Record<string, unknown>) => { registered = definition } },
  } as unknown as Context
  return {
    ctx,
    tool: () => {
      if (registered === undefined) throw new Error('工具未注册')
      return registered
    },
  }
}

/** 调工具 execute(参数为空对象,执行上下文测试里用不到)。 */
async function runTool(tool: Record<string, unknown>): Promise<string> {
  const execute = tool.execute as (args: unknown, exec: unknown) => Promise<string>
  return await execute({}, {})
}

beforeEach(() => {
  mockedSpawn.mockReset()
  nextProc = {}
  mockedSpawn.mockImplementation((() => fakeProc(nextProc)) as never)
})

describe('listAgyModelEntriesAsync:代理与解析', () => {
  it('proxy 透传三个环境变量,并按 tab 解析条目', async () => {
    nextProc = { stdout: 'model-a\tModel A\nmodel-b\n' }
    const { entries, stderrTail } = await listAgyModelEntriesAsync('agy', { proxy: 'http://127.0.0.1:7890' })
    expect(lastEnv()?.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(lastEnv()?.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(lastEnv()?.ALL_PROXY).toBe('http://127.0.0.1:7890')
    expect(entries).toEqual([{ id: 'model-a', name: 'Model A' }, { id: 'model-b' }])
    expect(stderrTail).toBe('')
  })

  it('无 proxy 时不覆盖 env', async () => {
    nextProc = { stdout: 'model-a\n' }
    await listAgyModelEntriesAsync('agy', {})
    expect(lastEnv()).toBeUndefined()
  })

  it('stdout 为空时条目为空,stderr 只留尾部 3 行', async () => {
    nextProc = { stderr: 'l1\nl2\nl3\nl4\nl5\n' }
    const { entries, stderrTail } = await listAgyModelEntriesAsync('agy', {})
    expect(entries).toEqual([])
    expect(stderrTail).toBe('l3\nl4\nl5')
  })
})

describe('list_agy_models:实时走设置里的代理', () => {
  it('execute 每次经 getter 取代理(设置面板改动立即生效)', async () => {
    nextProc = { stdout: 'model-a\tModel A\n' }
    let proxy = 'http://first:1111'
    const { ctx, tool } = harness()
    registerAgyModelsTool(ctx, { command: () => 'agy', proxy: () => proxy, toolName: 'list_agy_models' })

    const output = await runTool(tool())
    expect(output).toBe('- model-a — Model A')
    expect(lastEnv()?.HTTPS_PROXY).toBe('http://first:1111')

    // 设置面板改成另一个代理:不重启也要立即生效(getter 语义)。
    proxy = 'http://second:2222'
    await runTool(tool())
    expect(lastEnv()?.HTTPS_PROXY).toBe('http://second:2222')
    expect(mockedSpawn.mock.calls.at(-1)?.[0]).toBe('agy')
  })

  it('查询失败(空输出)时把 stderr 尾交给主代理诊断', async () => {
    nextProc = { stderr: 'Error: proxy unreachable\n' }
    const { ctx, tool } = harness()
    registerAgyModelsTool(ctx, { command: () => 'agy', proxy: () => 'http://dead:9', toolName: 'list_agy_models' })
    const output = await runTool(tool())
    expect(output).toContain('returned nothing')
    expect(output).toContain('proxy unreachable')
  })
})
