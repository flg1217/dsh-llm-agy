/**
 * image-paste 单元测试:
 * - 所有用户消息里的 ImageBlock 都转换为文本(文本模型的流式适配器会硬拒裸图片块);
 * - 最新用户输入用完整提示引导 read_image_agy;历史消息用中性路径引用,不重复消费;
 * - 转换为确定性输出:同一附件同会话永远同一路径文本 → 请求内容稳定,网关
 *   prompt 缓存照常命中;
 * - 同轮工具调用后的继续请求同样转换,内容与前序请求一致;
 * - 同一附件重复输入只落盘一次;
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

describe('convertPastedImages:全部图片转文本,最新完整提示,历史中性引用', () => {
  it('最新用户消息的图片块被替换为完整路径提示', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [{ role: 'user', content: [imageBlock('sha256-convert') as unknown as ContentBlock] }]

    const out = await convertPastedImages(ctx as never, messages, sessionId)

    expect(out).toHaveLength(1)
    const text = out[0]?.content[0]
    expect(text?.type).toBe('text')
    const normalized = (text as { text: string }).text.replace(/\\/g, '/')
    expect(normalized).toContain('.dsh-llm-agy/tmp/pasted-images')
    expect(normalized).toContain('请调用 read_image_agy')
    expect(pastedImageFiles()).toHaveLength(1)
  })

  it('历史消息里的图片块转换为中性路径引用,不引导重复消费', async () => {
    const { ctx, calls } = makeCtx()
    const messages: Message[] = [
      { role: 'user', content: [textBlock('看这张图'), imageBlock('sha256-history') as unknown as ContentBlock] },
      { role: 'assistant', content: [textBlock('分析完毕')] },
      { role: 'user', content: [textBlock('继续')] },
    ]

    const out = await convertPastedImages(ctx as never, messages, sessionId)

    // 图片被读取并落盘(历史也需要转换为文本,文本模型不能收裸图)。
    expect(calls[0]).toBe(1)
    expect(pastedImageFiles()).toHaveLength(1)
    // 历史用户消息:文本保留 + 中性引用;不含引导消费的完整提示。
    const history = out[0]?.content
    expect(history).toHaveLength(2)
    expect(history?.[0]).toStrictEqual(textBlock('看这张图'))
    const ref = history?.[1] as { text: string }
    expect(ref.text).toContain('图片已保存到')
    expect(ref.text).not.toContain('请调用 read_image_agy')
    // 不再残留任何 ImageBlock(文本模型适配器硬拒裸图)。
    expect(out.every((m) => m.content.every((b) => b.type !== 'image'))).toBe(true)
  })

  it('最新用户输入带图片时用完整提示,历史图片用中性引用', async () => {
    const { ctx, calls } = makeCtx()
    const messages: Message[] = [
      { role: 'user', content: [imageBlock('sha256-old') as unknown as ContentBlock] },
      { role: 'assistant', content: [textBlock('第一轮回答')] },
      { role: 'user', content: [imageBlock('sha256-latest') as unknown as ContentBlock] },
    ]

    const out = await convertPastedImages(ctx as never, messages, sessionId)

    expect(calls[0]).toBe(2)
    expect(pastedImageFiles()).toHaveLength(2)
    // 历史:中性引用。
    const oldText = out[0]?.content[0] as { text: string }
    expect(oldText.text).toContain('图片已保存到')
    expect(oldText.text).not.toContain('请调用 read_image_agy')
    // 最新:完整提示。
    const latestText = out[2]?.content[0] as { text: string }
    expect(latestText.text).toContain('请调用 read_image_agy')
    expect(out.every((m) => m.content.every((b) => b.type !== 'image'))).toBe(true)
  })

  it('同轮工具继续请求同样转换,内容与前序请求一致(确定性)', async () => {
    const { ctx, calls } = makeCtx()
    const continuation: Message[] = [
      { role: 'user', content: [imageBlock('sha256-turn') as unknown as ContentBlock] },
      { role: 'assistant', content: [textBlock('read_image_agy 调用')] },
      { role: 'tool', content: [textBlock('(工具结果)')] },
    ]

    const first = await convertPastedImages(ctx as never, continuation, sessionId)
    const second = await convertPastedImages(ctx as never, continuation, sessionId)

    // 同一附件只读一次、只落盘一次。
    expect(calls[0]).toBe(1)
    expect(pastedImageFiles()).toHaveLength(1)
    // 两次转换输出完全一致(请求内容稳定 → prompt 缓存命中)。
    expect(second).toStrictEqual(first)
    const text = first[0]?.content[0] as { text: string }
    expect(text.text).toContain('图片已保存到')
    expect(text.text).not.toContain('请调用 read_image_agy') // 同轮继续不是新输入。
    expect(first.every((m) => m.content.every((b) => b.type !== 'image'))).toBe(true)
  })

  it('同一附件再次作为新输入被处理时复用缓存路径,只产生一个文件', async () => {
    const { ctx, calls } = makeCtx()
    const messages: Message[] = [{ role: 'user', content: [imageBlock('sha256-cache') as unknown as ContentBlock] }]

    const first = await convertPastedImages(ctx as never, messages, sessionId)
    const second = await convertPastedImages(ctx as never, messages, sessionId)

    expect(calls[0]).toBe(1)
    expect(pastedImageFiles()).toHaveLength(1)
    expect(second).toStrictEqual(first)
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

  it('最新输入同时含文本和图片:文本保留,图片转换为完整提示', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [{
      role: 'user',
      content: [textBlock('分析这张图的配色'), imageBlock('sha256-mixed') as unknown as ContentBlock],
    }]

    const out = await convertPastedImages(ctx as never, messages, sessionId)

    expect(out[0]?.content).toHaveLength(2)
    expect(out[0]?.content[0]).toStrictEqual(textBlock('分析这张图的配色'))
    const text = out[0]?.content[1] as { text: string }
    expect(text.text).toContain('请调用 read_image_agy')
    expect(pastedImageFiles()).toHaveLength(1)
  })
})
