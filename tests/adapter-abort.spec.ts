/**
 * 适配器停止(abort)回归测试——针对"子代理页面点停止没反应"的根因:
 *
 * 只 `proc.kill()` + `stdout.destroy()` 并**不能**结束
 * `for await (const line of rl)`(readline 只认 rl.close() 或 EOF,实测)。
 * 当 AGY 的工具子进程残留、继续持有 stdout 写端时,这个读循环会永久挂起 →
 * 回合永远"进行中",再点停止也不会有效果(信号已中止,监听器已摘除)。
 *
 * 因此本测试锁死:abort → 杀进程树 + 关 readline → 流必须结束。
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyLlmAdapter } from '../src/adapter.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

/** 假 AGY 进程:stdout 永不产出、永不 EOF,kill 也不关流(模拟残留子进程持有写端)。 */
function stuckProc(): EventEmitter & Record<string, unknown> {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
  proc.stdout = new Readable({ read() { /* 永不产出、永不结束 */ } })
  proc.stderr = undefined
  proc.pid = 4242
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = vi.fn()
  return proc
}

const ctx = { get: () => undefined } as unknown as Context

function options(signal: AbortSignal): GenerateOptions {
  return {
    provider: 'agy',
    model: 'gemini-3.1-pro-high',
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }],
    signal,
  } as unknown as GenerateOptions
}

describe('AgyLlmAdapter:停止(abort)必须结束流', () => {
  it('进程被杀但 stdout 不 EOF 时,流也必须结束', async () => {
    const proc = stuckProc()
    mockedSpawn.mockImplementation(() => proc as unknown as ReturnType<typeof spawn>)
    const adapter = new AgyLlmAdapter(ctx, {
      command: 'agy',
      model: 'gemini-3.1-pro-high',
      effort: 'high',
      extraArgs: [],
    })
    const controller = new AbortController()
    const chunks: StreamChunk[] = []
    const consume = (async () => {
      for await (const chunk of adapter.stream(options(controller.signal))) chunks.push(chunk)
    })()
    // 等生成器推进到读循环(abort 监听器已注册)后再中止。
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()

    const outcome = await Promise.race([
      consume.then(() => 'ended' as const),
      new Promise<'hang'>(resolve => setTimeout(() => resolve('hang'), 1_000)),
    ])
    expect(outcome).toBe('ended')
    expect(proc.kill).toHaveBeenCalled()
    expect(chunks).toEqual([])
  })
})
