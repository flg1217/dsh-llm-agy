/**
 * image-paste 单元测试:
 * - 只消费"最新一条用户输入"里的图片:物化落盘 + 路径提示;
 * - 历史消息里的图片块请求级丢弃,不落盘、不转换、不写日志——同一张图
 *   永远不会被重复消费;
 * - 同一轮内多次请求(工具调用后继续)靠附件缓存复用同一路径;
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

function textBlock(text: string) {
  return { type: 'text', text }
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

describe('convertPastedImages:只消费最新一条用户输入', () => {
  it('唯一用户消息(即最新)的图片块被替换为含路径的文本块', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [{ role: 'user', content: [imageBlock('sha256-convert') as unknown as ContentBlock] }]

    const out = await convertPastedImages(ctx as never, messages, sessionId)

    expect(out).toHaveLength(1)
    const text = out[0]?.content[0]
    expect(text?.type).toBe('text')
    const normalized = (text as { text: string }).text.replace(/\\/g, '/')
    expect(normalized).toContain('.dsh-llm-agy/tmp/pasted-images')
    expect(normalized).toContain('read_image')
    expect(pastedImageFiles()).toHaveLength(1)
  })

  it('历史消息里的图片块被请求级丢弃:不落盘、不转换、不新增文件', async () => {
    const { ctx, calls } = makeCtx()
    const messages: Message[] = [
      { role: 'user', content: [textBlock('看这张图'), imageBlock('sha256-history') as unknown as ContentBlock] },
      { role: 'assistant', content: [textBlock('分析完毕')] },
      { role: 'user', content: [textBlock('继续')] },
    ]

    const out = await convertPastedImages(ctx as never, messages, sessionId)

    // 历史图片没有被读取、没有落盘。
    expect(calls[0]).toBe(0)
    expect(pastedImageFiles()).toHaveLength(0)
    // 历史用户消息保留了原有文本块、图片块被丢弃;最新用户输入原样保留。
    expect(out).toHaveLength(3)
    expect(out[0]?.content).toStrictEqual([textBlock('看这张图')])
    expect(out[0]?.content.some((b) => b.type === 'image')).toBe(false)
    expect(out[2]?.content).toStrictEqual([textBlock('继续')])
  })

  it('最新用户输入带图片时被转换,历史消息保持原样', async () => {
    const { ctx, calls } = makeCtx()
    const messages: Message[] = [
      { role: 'user', content: [textBlock('第一轮问题')] },
      { role: 'assistant', content: [textBlock('第一轮回答')] },
      { role: 'user', content: [imageBlock('sha256-latest') as unknown as ContentBlock] },
    ]

    const out = await convertPastedImages(ctx as never, messages, sessionId)

    expect(calls[0]).toBe(1)
    expect(pastedImageFiles()).toHaveLength(1)
    expect(out).toHaveLength(3)
    // 历史消息未被改动。
    expect(out[0]?.content).toStrictEqual([textBlock('第一轮问题')])
    // 最新输入被转换为路径提示。
    const text = out[2]?.content[0]
    expect(text?.type).toBe('text')
    expect((text as { text: string }).text).toContain('已保存到本地')
  })

  it('历史纯图片消息被丢弃后整条移除,不残留空消息', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [
      { role: 'user', content: [imageBlock('sha256-only') as unknown as ContentBlock] },
      { role: 'assistant', content: [textBlock('回答')] },
      { role: 'user', content: [textBlock('新问题')] },
    ]

    const out = await convertPastedImages(ctx as never, messages, sessionId)

    expect(out).toHaveLength(2)
    expect(out[0]?.content).toStrictEqual([textBlock('回答')])
    expect(out[1]?.content).toStrictEqual([textBlock('新问题')])
    expect(pastedImageFiles()).toHaveLength(0)
  })

  it('同一轮内多次请求(工具调用后继续)复用同一路径,不产生新文件', async () => {
    const { ctx, calls } = makeCtx()
    const messages: Message[] = [{ role: 'user', content: [imageBlock('sha256-sameturn') as unknown as ContentBlock] }]

    const first = await convertPastedImages(ctx as never, messages, sessionId)
    const second = await convertPastedImages(ctx as never, messages, sessionId)
    const third = await convertPastedImages(ctx as never, messages, sessionId)

    expect(calls[0]).toBe(1)
    expect(pastedImageFiles()).toHaveLength(1)
    const firstText = first[0]?.content[0]
    const thirdText = third[0]?.content[0]
    expect((firstText as { text: string }).text).toBe((thirdText as { text: string }).text)
  })

  it('无图片的消息原样返回', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [
      { role: 'user', content: [textBlock('hello')] },
      { role: 'assistant', content: [textBlock('hi')] },
    ]

    const out = await convertPastedImages(ctx as never, messages, sessionId)

    expect(out).toStrictEqual(messages)
  })

  it('最新输入同时含文本和图片:文本保留,图片转换为路径提示', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [{
      role: 'user',
      content: [textBlock('分析这张图的配色'), imageBlock('sha256-mixed') as unknown as ContentBlock],
    }]

    const out = await convertPastedImages(ctx as never, messages, sessionId)

    expect(out[0]?.content).toHaveLength(2)
    expect(out[0]?.content[0]).toStrictEqual(textBlock('分析这张图的配色'))
    const text = out[0]?.content[1]
    expect(text?.type).toBe('text')
    expect((text as { text: string }).text).toContain('已保存到本地')
    expect(pastedImageFiles()).toHaveLength(1)
  })
})
