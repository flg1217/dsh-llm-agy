/**
 * 适配器:AGY 文件类工具结果的 dsh 化补全(端到端,喂 stream-json)。
 *
 * 锁死两条链路:
 * - view_file 的 DONE → tool/result 文本 = 原始摘要 + 文件头部预览(行号格式);
 * - replace_file_content 的 ACTIVE 快照 + DONE 重读 → tool/result 文本 = 本次 diff。
 * (AGY 自身只回传路径与摘要/空结果;正文与差异由适配器按路径自行补全。)
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyLlmAdapter } from '../src/adapter.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

/** 假 AGY 进程:把给定的 stream-json 行以 latin1 字节吐出后自然结束。 */
function scriptedProc(lines: string[]): EventEmitter & Record<string, unknown> {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
  const payload = lines.map((l) => Buffer.from(l, 'utf8').toString('latin1')).join('\n') + '\n'
  proc.stdout = Readable.from([payload])
  proc.stderr = undefined
  proc.pid = 5151
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = vi.fn()
  proc.stdout.on('end', () => setTimeout(() => {
    proc.exitCode = 0
    proc.emit('exit', 0, null)
    proc.emit('close', 0, null)
  }, 10))
  return proc
}

/**
 * 受控假进程:测试自己 push 行(pushLine)与结束(end),时序确定——
 * 用于构造"ACTIVE 已被适配器处理(快照已取)之后再改文件"的场景。
 */
function pushProc(): EventEmitter & Record<string, unknown> & { pushLine: (l: string) => void; end: () => void } {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown> & { pushLine: (l: string) => void; end: () => void }
  proc.stdout = new Readable({ read() { /* 由测试 push */ } })
  proc.stderr = undefined
  proc.pid = 5153
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = vi.fn()
  proc.pushLine = (l: string) => { (proc.stdout as Readable).push(Buffer.from(l, 'utf8').toString('latin1') + '\n') }
  proc.end = () => {
    ;(proc.stdout as Readable).push(null)
    setTimeout(() => {
      proc.exitCode = 0
      proc.emit('exit', 0, null)
      proc.emit('close', 0, null)
    }, 10)
  }
  return proc
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const appended: Array<{ type: string; data: unknown }> = []
const session = {
  header: { cwd: process.cwd(), id: 'sess-preview' },
  ownEvents: () => [],
  append: (type: string, data: unknown) => {
    appended.push({ type, data })
    return { seq: appended.length }
  },
}
const ctx = {
  get: (key: string) => (key === 'sessions' ? { get: () => session } : undefined),
} as unknown as Context

function options(): GenerateOptions {
  return {
    provider: 'agy',
    model: 'gemini-3.1-pro-high',
    sessionId: 'sess-preview',
    messages: [{ role: 'user', content: [{ type: 'text', text: '干活' }] }],
  } as unknown as GenerateOptions
}

/** 取出 tool/result 事件里的文本内容。 */
function resultTexts(): string[] {
  return appended
    .filter((e) => e.type === 'tool/result')
    .map((e) => {
      const message = (e.data as { message?: { content?: readonly { content?: readonly { text?: string }[] }[] } }).message
      return message?.content?.[0]?.content?.[0]?.text ?? ''
    })
}

function stepLine(state: string, toolName: string, stepIndex: number, toolInfo: unknown): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: {
      step_type: 'tool', state, step_index: stepIndex, tool_name: toolName, tool_info: toolInfo,
    },
  })
}

describe('AgyLlmAdapter:文件类工具结果补全', () => {
  let dir: string
  beforeEach(() => {
    appended.length = 0
    mockedSpawn.mockClear()
    dir = mkdtempSync(join(tmpdir(), 'agy-adapter-preview-'))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function drive(lines: string[]): Promise<void> {
    mockedSpawn.mockImplementation(() => scriptedProc(lines) as unknown as ReturnType<typeof spawn>)
    const adapter = new AgyLlmAdapter(ctx, {
      command: 'agy', model: 'gemini-3.1-pro-high', effort: 'high', extraArgs: [],
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
  }

  it('view_file:摘要 + 文件头部预览进 tool/result', async () => {
    const file = join(dir, 'view.txt')
    writeFileSync(file, '# 标题\n正文一\n正文二')
    await drive([
      stepLine('ACTIVE', 'view_file', 1, { parameters: { AbsolutePath: file } }),
      stepLine('DONE', 'view_file', 1, { output: '3 lines, 18 bytes' }),
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }),
    ])
    const texts = resultTexts()
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('3 lines, 18 bytes')
    expect(texts[0]).toContain('1→# 标题')
    expect(texts[0]).toContain('3→正文二')
  })

  it('replace_file_content:快照对比出本次 diff 进 tool/result', async () => {
    const file = join(dir, 'edit.txt')
    writeFileSync(file, 'keep\nalt\nkeep2')
    const proc = pushProc()
    mockedSpawn.mockImplementation(() => proc as unknown as ReturnType<typeof spawn>)
    const adapter = new AgyLlmAdapter(ctx, {
      command: 'agy', model: 'gemini-3.1-pro-high', effort: 'high', extraArgs: [],
    })
    const consume = (async () => {
      for await (const _chunk of adapter.stream(options())) { /* 只关心会话事件 */ }
    })()
    // ACTIVE → 等适配器处理完(快照已取)→ 模拟 AGY 完成编辑 → DONE。
    proc.pushLine(stepLine('ACTIVE', 'replace_file_content', 2, { parameters: { TargetFile: file } }))
    await waitFor(() => appended.some((e) => e.type === 'tool/call'))
    writeFileSync(file, 'keep\nNEW\nkeep2')
    proc.pushLine(stepLine('DONE', 'replace_file_content', 2, { output: '' }))
    proc.pushLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
    proc.end()
    await consume

    const text = resultTexts()[0]
    expect(text).toContain('- 2│alt')
    expect(text).toContain('+ 2│NEW')
    expect(text).toContain('  1│keep')
  })

  it('文件未变更时 view_file 预览失败也不影响原始结果', async () => {
    await drive([
      stepLine('ACTIVE', 'view_file', 3, { parameters: { AbsolutePath: join(dir, 'missing.txt') } }),
      stepLine('DONE', 'view_file', 3, { output: '0 lines' }),
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }),
    ])
    expect(resultTexts()[0]).toBe('0 lines')
  })

  it('view_file 读到图片:提交附件并以 image 内容块入结果(不走文本预览)', async () => {
    const png = join(dir, 'shot.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))
    const saved: Array<{ mediaType: string; bytes: number; name?: string }> = []
    const attachments = {
      saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
        saved.push({ mediaType: input.mediaType, bytes: input.data.byteLength, ...(input.name === undefined ? {} : { name: input.name }) })
        return { attachmentId: 'sha256:testimg', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, ...(input.name === undefined ? {} : { name: input.name }) }
      },
    }
    mockedSpawn.mockImplementation(() => scriptedProc([
      stepLine('ACTIVE', 'view_file', 4, { parameters: { AbsolutePath: png } }),
      stepLine('DONE', 'view_file', 4, { output: 'PNG image' }),
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }),
    ]) as unknown as ReturnType<typeof spawn>)
    const adapter = new AgyLlmAdapter(ctx, {
      command: 'agy', model: 'gemini-3.1-pro-high', effort: 'high', extraArgs: [],
      getAttachments: () => attachments,
    })
    for await (const _chunk of adapter.stream(options())) { /* 只关心会话事件 */ }

    expect(saved).toEqual([{ mediaType: 'image/png', bytes: 12, name: 'shot.png' }])
    const resultEvent = appended.find((e) => e.type === 'tool/result')
    const content = (resultEvent?.data as { message?: { content?: readonly { content?: readonly { type: string; text?: string; attachment?: { attachmentId?: string } }[] }[] } })
      ?.message?.content?.[0]?.content ?? []
    expect(content).toHaveLength(2)
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toBe('PNG image') // 二进制不落文本预览
    expect(content[1]?.type).toBe('image')
    expect(content[1]?.attachment?.attachmentId).toBe('sha256:testimg')
  })
})
