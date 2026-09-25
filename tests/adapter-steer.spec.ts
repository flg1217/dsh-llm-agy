/**
 * 插话中断(steer)回归测试:
 * - AGY CLI 不支持回合内 steer/interrupt(实测忽略 interrupt event),运行中
 *   插话只能由适配器中断当前轮实现;
 * - 锁死行为:`agent/inbox/spliced`(next-step + user 来源)→ 杀进程、按已
 *   发送写锚点、流正常结束(不 hang、不重试)——agent-loop 随后 claim 插入
 *   开下一 step,resumeReplayPrompt 只补发插话内容。
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyLlmAdapter } from '../src/adapter.ts'
import type { ConversationStore } from '../src/conversations.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

/** 可控伪 AGY 进程:stdout 由测试逐行 push,stdin 记录写入。 */
function fakeProc(): EventEmitter & Record<string, unknown> {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
  proc.stdout = new Readable({ read() { /* 由 push 驱动 */ } })
  proc.stderr = new Readable({ read() { /* 无输出 */ } })
  proc.stdin = { write: vi.fn(), end: vi.fn() }
  proc.pid = 4242
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = vi.fn()
  return proc
}

interface Harness {
  adapter: AgyLlmAdapter
  proc: EventEmitter & Record<string, unknown>
  handlers: Array<(session: unknown, event: unknown) => void>
  anchor: ReturnType<typeof vi.fn>
  push: (line: string) => void
}

function makeHarness(sessionId: string): Harness {
  const proc = fakeProc()
  mockedSpawn.mockImplementation(((cmd: string) => {
    if (cmd === 'taskkill') return { on: vi.fn() }
    return proc
  }) as unknown as ReturnType<typeof spawn>)
  const handlers: Array<(session: unknown, event: unknown) => void> = []
  const ctx = {
    get: () => undefined,
    on: (_name: string, handler: (session: unknown, event: unknown) => void) => {
      handlers.push(handler)
      return () => {}
    },
  } as unknown as Context
  const anchor = vi.fn()
  const adapter = new AgyLlmAdapter(ctx, {
    command: 'agy',
    model: 'gemini-3.7-flash-high',
    effort: 'high',
    extraArgs: [],
    store: { set: anchor, get: () => undefined } as unknown as ConversationStore,
  })
  const push = (line: string): void => {
    ;(proc.stdout as Readable).push(`${line}\n`)
  }
  push(JSON.stringify({ event: 'init', conversation_id: 'cid-steer', init: { model: 'm' } }))
  return { adapter, proc, handlers, anchor, push }
}

function options(sessionId: string): GenerateOptions {
  return {
    provider: 'agy',
    model: 'gemini-3.7-flash-high',
    sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: '慢慢数数' }] }],
  } as unknown as GenerateOptions

}

describe('AgyLlmAdapter:插话中断(steer)', () => {
  it('next-step 用户插话 → 杀进程、写锚点、流正常结束', async () => {
    const h = makeHarness('s-steer')
    const chunks: StreamChunk[] = []
    const consume = (async () => {
      for await (const chunk of h.adapter.stream(options('s-steer'))) chunks.push(chunk)
    })()
    // 推进到读循环后注入一段输出,再派发插话事件。
    await new Promise(resolve => setTimeout(resolve, 20))
    h.push(JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: 'cid-steer', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '1\n2\n3' },
    }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.handlers.length).toBeGreaterThan(0)
    for (const handler of h.handlers) {
      handler({ header: { id: 's-steer' } }, {
        type: 'agent/inbox/spliced',
        data: { target: 'next-step', start: 0, removedCount: 0, inserted: [
          { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '停下,先回答我' }] },
        ] },
      })
    }

    const outcome = await Promise.race([
      consume.then(() => 'ended' as const),
      new Promise<'hang'>(resolve => setTimeout(() => resolve('hang'), 1_500)),
    ])
    expect(outcome).toBe('ended')
    expect(h.proc.kill).toHaveBeenCalled()
    // 锚点按已发送写:后续续跑只补发插话内容,不重发原任务。
    expect(h.anchor).toHaveBeenCalledWith('s-steer', expect.objectContaining({
      conversationId: 'cid-steer',
      sentCount: 1,
    }))
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('next-turn 排队插入、非用户来源与别的会话都不触发中断', async () => {
    const h = makeHarness('s-queue')
    const consume = (async () => {
      for await (const _chunk of h.adapter.stream(options('s-queue'))) { /* 不断流:保持读循环 */ }
    })().catch(() => { /* 断流收尾 */ })
    await new Promise(resolve => setTimeout(resolve, 20))
    for (const handler of h.handlers) {
      handler({ header: { id: 's-queue' } }, {
        type: 'agent/inbox/spliced',
        data: { target: 'next-turn', inserted: [
          { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '排队消息' }] },
        ] },
      })
      handler({ header: { id: 's-queue' } }, {
        type: 'agent/inbox/spliced',
        data: { target: 'next-step', inserted: [
          { id: 'm3', source: { kind: 'plugin' }, content: [{ type: 'text', text: '插件注入上下文' }] },
        ] },
      })
      handler({ header: { id: 'other-session' } }, {
        type: 'agent/inbox/spliced',
        data: { target: 'next-step', inserted: [
          { id: 'm4', source: { kind: 'user' }, content: [{ type: 'text', text: '别的会话的插话' }] },
        ] },
      })
    }
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(h.proc.kill).not.toHaveBeenCalled()
    expect(h.anchor).not.toHaveBeenCalled()
    ;(h.proc.stdout as Readable).destroy()
    await Promise.race([consume, new Promise(resolve => setTimeout(resolve, 200))])
  })

  it('主代理 send_message(agent-message 来源)同样触发中断', async () => {
    const h = makeHarness('s-agent-msg')
    const chunks: StreamChunk[] = []
    const consume = (async () => {
      for await (const chunk of h.adapter.stream(options('s-agent-msg'))) chunks.push(chunk)
    })()
    await new Promise(resolve => setTimeout(resolve, 20))
    for (const handler of h.handlers) {
      handler({ header: { id: 's-agent-msg' } }, {
        type: 'agent/inbox/spliced',
        data: { target: 'next-step', start: 0, removedCount: 0, inserted: [
          { id: 'a1', source: { kind: 'agent-message' }, content: [{ type: 'text', text: '补充:改用方案 B' }] },
        ] },
      })
    }
    const outcome = await Promise.race([
      consume.then(() => 'ended' as const),
      new Promise<'hang'>(resolve => setTimeout(() => resolve('hang'), 1_500)),
    ])
    expect(outcome).toBe('ended')
    expect(h.proc.kill).toHaveBeenCalled()
    expect(h.anchor).toHaveBeenCalledWith('s-agent-msg', expect.objectContaining({ sentCount: 1 }))
  })
})
