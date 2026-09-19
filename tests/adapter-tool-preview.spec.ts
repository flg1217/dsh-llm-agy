/**
 * 适配器:AGY 文件类工具结果的 dsh 化补全(端到端,喂 stream-json)。
 *
 * 架构:常驻进程(--input-format stream-json),轮状态由 stdin 写入建立;
 * 测试在 push 事件前等 stdin(轮已建立)。工具结果的异步补全(view_file
 * 预览/图片、edit diff)在轮收尾前由 pendingEnrich 统一完成。
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
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyLlmAdapter } from '../src/adapter.ts'
import { ConversationStore } from '../src/conversations.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

/** 假 AGY 常驻进程:测试 push 行(stdin 收集;不自动退出)。 */
interface PushProc extends EventEmitter {
  stdout: Readable
  stderr: Readable
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  stdinWrites: string[]
  pid: number
  exitCode: number | null
  signalCode: string | null
  kill: ReturnType<typeof vi.fn>
  pushLine: (l: string) => void
  end: () => void
}

function pushProc(): PushProc {
  const proc = new EventEmitter() as PushProc
  const stdinWrites: string[] = []
  proc.stdout = new Readable({ read() { /* 由测试 push */ } })
  proc.stderr = new Readable({ read() { /* 无输出 */ } })
  proc.stdinWrites = stdinWrites
  proc.stdin = {
    write: vi.fn((chunk: string) => { stdinWrites.push(chunk); return true }),
    end: vi.fn(),
  }
  proc.pid = 5153
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = vi.fn()
  proc.pushLine = (l: string) => { (proc.stdout as Readable).push(`${l}\n`) }
  proc.end = () => { (proc.stdout as Readable).push(null) }
  return proc
}

/** spawn 分流:agy → 假进程;taskkill(进程树杀)→ 哑对象。 */
function route(proc: PushProc): void {
  mockedSpawn.mockImplementation(((cmd: string) => {
    if (cmd === 'taskkill') return { on: vi.fn() }
    return proc
  }) as unknown as typeof spawn)
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
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '干活' }], source: { kind: 'user' } }],
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
    mockedSpawn.mockReset()
    dir = mkdtempSync(join(tmpdir(), 'agy-adapter-preview-'))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** 跑一轮:起消费 → 等 stdin(轮建立)→ 推项目行 → 结束 → 等消费完成。 */
  async function drive(lines: string[], adapterOptions?: Record<string, unknown>): Promise<void> {
    const proc = pushProc()
    route(proc)
    const adapter = new AgyLlmAdapter(ctx, {
      command: 'agy', model: 'gemini-3.1-pro-high', effort: 'high', extraArgs: [],
      store: new ConversationStore(null),
      ...adapterOptions,
    })
    const consume = (async () => {
      for await (const _chunk of adapter.stream(options())) { /* 只关心会话事件 */ }
    })()
    await waitFor(() => proc.stdinWrites.length >= 1)
    for (const line of lines) proc.pushLine(line)
    proc.end()
    await consume
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
    // 非图片路径不映射:保持 view_file 原样。
    const callEvent = appended.find((e) => e.type === 'tool/call')
    expect((callEvent?.data as { name?: string })?.name).toBe('view_file')
  })

  it('replace_file_content:快照对比出本次 diff 进 tool/result', async () => {
    const file = join(dir, 'edit.txt')
    writeFileSync(file, 'keep\nalt\nkeep2')
    const proc = pushProc()
    route(proc)
    const adapter = new AgyLlmAdapter(ctx, {
      command: 'agy', model: 'gemini-3.1-pro-high', effort: 'high', extraArgs: [],
      store: new ConversationStore(null),
    })
    const consume = (async () => {
      for await (const _chunk of adapter.stream(options())) { /* 只关心会话事件 */ }
    })()
    await waitFor(() => proc.stdinWrites.length >= 1)
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

  it('view_file 读到图片:映射为 dsh 原生 read_image(工具名/参数/信封 + image 块)', async () => {
    const png = join(dir, 'shot.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))
    const saved: Array<{ mediaType: string; bytes: number; name?: string }> = []
    const attachments = {
      saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
        saved.push({ mediaType: input.mediaType, bytes: input.data.byteLength, ...(input.name === undefined ? {} : { name: input.name }) })
        return { attachmentId: 'sha256:testimg', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, ...(input.name === undefined ? {} : { name: input.name }) }
      },
    }
    await drive([
      stepLine('ACTIVE', 'view_file', 4, { parameters: { AbsolutePath: png } }),
      stepLine('DONE', 'view_file', 4, { output: 'PNG image' }),
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }),
    ], { getAttachments: () => attachments })

    expect(saved).toEqual([{ mediaType: 'image/png', bytes: 12, name: 'shot.png' }])
    // 工具调用映射成原生 read_image 的形状(名字 + file_path 参数)。
    const callEvent = appended.find((e) => e.type === 'tool/call')
    const callData = callEvent?.data as { name?: string; arguments?: string }
    expect(callData?.name).toBe('read_image')
    expect(JSON.parse(callData?.arguments ?? '{}')).toEqual({ file_path: png })
    // 结果:文本 = dsh 原生读图信封(路径/类型/尺寸),图片本体走相邻 image 块。
    const resultEvent = appended.find((e) => e.type === 'tool/result')
    const content = (resultEvent?.data as { message?: { content?: readonly { content?: readonly { type: string; text?: string; attachment?: { attachmentId?: string } }[] }[] } })
      ?.message?.content?.[0]?.content ?? []
    expect(content).toHaveLength(2)
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toContain(`<path>${png}</path>`)
    expect(content[0]?.text).toContain('<type>image</type>')
    expect(content[0]?.text).toContain('image/png image, 1x1 px, 12 bytes')
    expect(content[0]?.text).not.toContain('PNG image') // AGY 摘要被信封替换
    expect(content[1]?.type).toBe('image')
    expect(content[1]?.attachment?.attachmentId).toBe('sha256:testimg')
  })

  it('call_mcp_tool(ServerName=dsh):翻译为 dsh 原生工具名/参数(渲染原生卡片)', async () => {
    await drive([
      stepLine('ACTIVE', 'call_mcp_tool', 7, {
        parameters: { ServerName: 'dsh', ToolName: 'pwsh', Arguments: { command: 'echo hi' } },
      }),
      stepLine('DONE', 'call_mcp_tool', 7, { output: 'hi\n' }),
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }),
    ])
    // 工具调用 = dsh 原生形态(名字 + 真实参数),而不是 call_mcp_tool 壳。
    const callData = appended.find((e) => e.type === 'tool/call')?.data as { name?: string; arguments?: string }
    expect(callData?.name).toBe('pwsh')
    expect(JSON.parse(callData?.arguments ?? '{}')).toEqual({ command: 'echo hi' })
    // 结果照旧:dsh 侧执行的 stdout(AGY 报回)。
    expect(resultTexts()[0]).toBe('hi\n')
  })

  it('call_mcp_tool 指向其它 MCP 服务器(codegraph 等):保留原样,不经 dsh 翻译', async () => {
    await drive([
      stepLine('ACTIVE', 'call_mcp_tool', 8, {
        parameters: { ServerName: 'codegraph', ToolName: 'query', Arguments: { q: 'x' } },
      }),
      stepLine('DONE', 'call_mcp_tool', 8, { output: 'graph result' }),
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }),
    ])
    const callData = appended.find((e) => e.type === 'tool/call')?.data as { name?: string; arguments?: string }
    expect(callData?.name).toBe('call_mcp_tool')
    expect(JSON.parse(callData?.arguments ?? '{}')).toEqual({
      ServerName: 'codegraph', ToolName: 'query', Arguments: { q: 'x' },
    })
  })

  it('ACTIVE 无参数、DONE 才带参数:callId 仍与 ACTIVE 一致(不漂移)', async () => {
    // 回归:ACTIVE 空壳(参数流式补全前)不写缓存 → DONE 用自带参数映射成功,
    // callName 从 call_mcp_tool 变成 pwsh,重算的 callId 与落地的 tool/call
    // 不再相等 → tool/result 成为孤儿(前端配对断裂)。
    await drive([
      stepLine('ACTIVE', 'call_mcp_tool', 9, {}),
      stepLine('DONE', 'call_mcp_tool', 9, {
        parameters: { ServerName: 'dsh', ToolName: 'pwsh', Arguments: { command: 'echo hi' } },
        output: 'hi',
      }),
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }),
    ])
    const call = appended.find((e) => e.type === 'tool/call')?.data as { callId?: string }
    const result = appended.find((e) => e.type === 'tool/result')?.data as {
      message?: { source?: { callId?: string } }
    }
    expect(call?.callId).toBeDefined()
    expect(result?.message?.source?.callId).toBe(call?.callId)
  })

  it('MCP 读图的落盘媒体:代读回填 image 块(信封用调用参数路径,预览恢复)', async () => {
    // 回归:AGY 收到 MCP 的 image 内容块时不交给模型,而是落 brain 媒体文件,
    // output 只剩信封 + [Resource offloaded to ...]——读图卡片只有文字没有图片。
    const png = join(dir, 'media_0.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8]))
    const saved: Array<{ mediaType: string; bytes: number; name?: string }> = []
    const attachments = {
      saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
        saved.push({ mediaType: input.mediaType, bytes: input.data.byteLength, ...(input.name === undefined ? {} : { name: input.name }) })
        return { attachmentId: 'sha256:offloaded', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 }
      },
    }
    const output = [
      '<path>D:/orig/v8-detail-open.png</path>',
      '<type>image</type>',
      '<content>',
      'image/png image, 1920x1080 px, 425165 bytes',
      '</content>',
      `[Resource offloaded to ${pathToFileURL(png).href}]`,
    ].join('\n')
    await drive([
      stepLine('ACTIVE', 'read_image', 11, { parameters: { file_path: 'D:/orig/v8-detail-open.png' } }),
      stepLine('DONE', 'read_image', 11, { output }),
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }),
    ], { getAttachments: () => attachments })

    expect(saved).toEqual([{ mediaType: 'image/png', bytes: 12, name: 'media_0.png' }])
    const resultEvent = appended.find((e) => e.type === 'tool/result')
    const content = (resultEvent?.data as { message?: { content?: readonly { content?: readonly { type: string; text?: string; attachment?: { attachmentId?: string } }[] }[] } })
      ?.message?.content?.[0]?.content ?? []
    expect(content).toHaveLength(2)
    expect(content[0]?.type).toBe('text')
    // 信封用调用参数路径(可定位原始文件),落盘提示行不进入结果。
    expect(content[0]?.text).toContain('<path>D:/orig/v8-detail-open.png</path>')
    expect(content[0]?.text).not.toContain('Resource offloaded')
    expect(content[1]?.type).toBe('image')
    expect(content[1]?.attachment?.attachmentId).toBe('sha256:offloaded')
  })
})
