/**
 * image-paste 单元测试:
 * - 同一附件在同一会话内只落盘一次(回归:历史消息每次请求重放导致的重复文件堆积);
 * - 不同附件 / 不同会话各自落盘;
 * - 扩展名映射与消息转换行为。
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertPastedImages, materializeImage } from '../src/image-paste.ts'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** 每个测试一个独立工作区,避免模块级缓存跨用例串扰。 */
let workspace: string
let sessionId: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dsh-llm-agy-image-paste-'))
  sessionId = `session-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

/** 记录 readImage 调用次数的伪附件服务。 */
function makeCtx(cwd = workspace, calls: number[] = [0]) {
  const readImage = vi.fn(async () => {
    calls[0] += 1
    return { data: new Uint8Array([1, 2, 3, 4]) }
  })
  const ctx = {
    get: (key: string) => {
      if (key === 'attachments') return { readImage }
      if (key === 'sessions') return { get: () => ({ header: { cwd } }) }
      return undefined
    },
  }
  return { ctx, readImage, calls }
}

function imageBlock(attachmentId: string, mediaType = 'image/png') {
  return { type: 'image', attachment: { attachmentId, mediaType } }
}

function pastedImageFiles(): string[] {
  const dir = join(workspace, '.dsh-llm-agy/tmp/pasted-images')
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

describe('materializeImage:同一附件只落盘一次', () => {
  it('同一附件在同一会话重复处理返回同一路径,且只写一个文件', async () => {
    const { ctx, readImage, calls } = makeCtx()
    const block = imageBlock('sha256_duplicate-check')

    const first = await materializeImage(ctx as never, block as never, sessionId)
    const second = await materializeImage(ctx as never, block as never, sessionId)
    const third = await materializeImage(ctx as never, block as never, sessionId)

    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(calls[0]).toBe(1)
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(pastedImageFiles()).toHaveLength(1)
    // 文件真实存在且可读。
    expect(statSync(first).isFile()).toBe(true)
  })

  it('同一附件在不同会话各自落盘,不互相命中缓存', async () => {
    const { ctx } = makeCtx()
    const block = imageBlock('sha256-cross-session')
    const otherSession = `${sessionId}-other`

    const a = await materializeImage(ctx as never, block as never, sessionId)
    const b = await materializeImage(ctx as never, block as never, otherSession)

    expect(a).not.toBe(b)
    expect(pastedImageFiles()).toHaveLength(2)
  })

  it('不同附件产生不同文件', async () => {
    const { ctx } = makeCtx()
    const a = await materializeImage(ctx as never, imageBlock('sha256-one') as never, sessionId)
    const b = await materializeImage(ctx as never, imageBlock('sha256-two') as never, sessionId)

    expect(a).not.toBe(b)
    expect(pastedImageFiles()).toHaveLength(2)
  })
})

describe('materializeImage:路径与扩展名', () => {
  it('按媒体类型映射扩展名', async () => {
    const { ctx } = makeCtx()
    const png = await materializeImage(ctx as never, imageBlock('sha256-png') as never, sessionId)
    const jpg = await materializeImage(ctx as never, imageBlock('sha256-jpg', 'image/jpeg') as never, sessionId)
    const gif = await materializeImage(ctx as never, imageBlock('sha256-gif', 'image/gif') as never, sessionId)
    const webp = await materializeImage(ctx as never, imageBlock('sha256-webp', 'image/webp') as never, sessionId)
    const unknown = await materializeImage(ctx as never, imageBlock('sha256-unknown', 'image/avif') as never, sessionId)

    expect(png).toMatch(/\.png$/)
    expect(jpg).toMatch(/\.jpg$/)
    expect(gif).toMatch(/\.gif$/)
    expect(webp).toMatch(/\.webp$/)
    expect(unknown).toMatch(/\.img$/)
  })

  it('附件服务不可用时返回提示文本而不是抛错', async () => {
    const ctx = { get: () => undefined }
    const result = await materializeImage(ctx as never, imageBlock('sha256-noservice') as never, sessionId)
    expect(result).toContain('附件服务不可用')
  })
})

describe('convertPastedImages:ImageBlock → 路径文本', () => {
  it('把用户消息里的图片块替换为含路径的文本块', async () => {
    const { ctx } = makeCtx()
    const block = imageBlock('sha256-convert')
    const messages: Message[] = [
      { role: 'user', content: [block as unknown as ContentBlock] },
    ]

    const out = await convertPastedImages(ctx as never, messages, sessionId)

    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe('user')
    const text = out[0]?.content[0]
    expect(text?.type).toBe('text')
    // Windows 上路径分隔符是反斜杠,统一按 `/` 断言。
    const normalized = (text as { text: string }).text.replace(/\\/g, '/')
    expect(normalized).toContain('.dsh-llm-agy/tmp/pasted-images')
    expect(normalized).toContain('read_image')
    expect(pastedImageFiles()).toHaveLength(1)
  })

  it('无图片的消息原样返回', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]

    const out = await convertPastedImages(ctx as never, messages, sessionId)

    expect(out).toStrictEqual(messages)
  })

  it('同一图片消息被反复转换(模拟历史重放):首次落盘并提示,之后丢弃不再消费', async () => {
    const { ctx, calls } = makeCtx()
    const block = imageBlock('sha256-replay')
    const messages: Message[] = [{ role: 'user', content: [block as unknown as ContentBlock] }]

    const first = await convertPastedImages(ctx as never, messages, sessionId)
    const second = await convertPastedImages(ctx as never, messages, sessionId)
    const third = await convertPastedImages(ctx as never, messages, sessionId)

    // 只读一次附件、只写一个文件。
    expect(calls[0]).toBe(1)
    expect(pastedImageFiles()).toHaveLength(1)
    // 首次转换:提示模型阅读图片。
    const firstText = first[0]?.content[0]
    expect(firstText?.type).toBe('text')
    expect((firstText as { text: string }).text).toContain('已保存到本地')
    // 后续重放:不再提示消费同一张图(丢弃图片块,仅保留最小占位)。
    for (const out of [second, third]) {
      const text = out[0]?.content[0]
      expect(text?.type).toBe('text')
      expect((text as { text: string }).text).not.toContain('已保存到本地')
      expect((text as { text: string }).text).not.toContain('read_image')
    }
  })

  it('带文本的图片消息:首次转换保留文本+路径提示,后续重放只保留文本', async () => {
    const { ctx, calls } = makeCtx()
    const messages: Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: '分析这张图的配色' },
        imageBlock('sha256-mixed') as unknown as ContentBlock,
      ],
    }]

    const first = await convertPastedImages(ctx as never, messages, sessionId)
    const second = await convertPastedImages(ctx as never, messages, sessionId)

    expect(calls[0]).toBe(1)
    expect(pastedImageFiles()).toHaveLength(1)
    // 首次:两个块(文本 + 路径提示)。
    expect(first[0]?.content).toHaveLength(2)
    // 后续:只剩文本块,图片被丢弃。
    expect(second[0]?.content).toHaveLength(1)
    expect(second[0]?.content[0]?.type).toBe('text')
    expect((second[0]?.content[0] as { text: string }).text).toBe('分析这张图的配色')
  })
})
