/**
 * image-paste 单元测试(当前行为):
 * - 所有用户消息里的 ImageBlock 都转换为统一描述模板 `[用户粘贴的图片内容:<描述>]`
 *   (文本模型的流式适配器会硬拒裸图片块,历史消息同样转换);
 * - 转换是确定性的:同一附件同进程只读图一次(缓存),请求内容稳定 → 网关
 *   prompt 缓存命中;
 * - 同轮工具调用后的继续请求同样转换,内容与前序请求一致;
 * - 附件服务不可用/读取失败时输出占位文本,不抛错。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { convertPastedImages } from '../src/image-paste.ts'
import { agyReadImage } from '../src/read-image.ts'

/** mock AGY 读图:测试不真正 spawn agy 进程。 */
vi.mock('../src/read-image.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/read-image.ts')>()
  return {
    ...actual,
    agyReadImage: vi.fn(async () => '一张猫的图片'),
  }
})

const mockedAgyReadImage = vi.mocked(agyReadImage)

/** 每个测试一个独立工作区,避免模块级缓存跨用例串扰。 */
let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dsh-llm-agy-image-paste-'))
  mockedAgyReadImage.mockClear()
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

/** 伪附件服务:记录 readImage 调用次数,返回固定图片字节。 */
function makeCtx(calls: number[] = [0]) {
  const readImage = vi.fn(async () => {
    calls[0] += 1
    return { data: new Uint8Array([1, 2, 3, 4]) }
  })
  const ctx = {
    get: (key: string) => {
      if (key === 'attachments') return { readImage }
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

/** convertPastedImages 的当前调用方式:第三参是配置读取函数。 */
const getOptions = () => ({ command: 'agy', proxy: '' })

describe('convertPastedImages:统一描述模板', () => {
  it('最新用户消息的图片块被替换为统一描述模板文本', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [{ role: 'user', content: [imageBlock('sha256-convert') as unknown as ContentBlock] }]

    const out = await convertPastedImages(ctx as never, messages, getOptions)

    expect(out).toHaveLength(1)
    const text = out[0]?.content[0]
    expect(text?.type).toBe('text')
    expect((text as { text: string }).text).toBe('[用户粘贴的图片内容:一张猫的图片]')
    expect(mockedAgyReadImage).toHaveBeenCalledTimes(1)
  })

  it('历史消息里的图片块同样转换为描述文本,不区分历史/最新', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [
      { role: 'user', content: [textBlock('看这张图'), imageBlock('sha256-history') as unknown as ContentBlock] },
      { role: 'assistant', content: [textBlock('分析完毕')] },
      { role: 'user', content: [textBlock('继续')] },
    ]

    const out = await convertPastedImages(ctx as never, messages, getOptions)

    const history = out[0]?.content
    expect(history).toHaveLength(2)
    expect(history?.[0]).toStrictEqual(textBlock('看这张图'))
    expect(history?.[1]).toStrictEqual({ type: 'text', text: '[用户粘贴的图片内容:一张猫的图片]' })
    // 不再残留任何 ImageBlock(文本模型适配器硬拒裸图)。
    expect(out.every((m) => m.content.every((b) => b.type !== 'image'))).toBe(true)
  })

  it('最新输入带图片时同样使用统一模板', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [
      { role: 'user', content: [imageBlock('sha256-old') as unknown as ContentBlock] },
      { role: 'assistant', content: [textBlock('第一轮回答')] },
      { role: 'user', content: [imageBlock('sha256-latest') as unknown as ContentBlock] },
    ]

    const out = await convertPastedImages(ctx as never, messages, getOptions)

    const oldText = out[0]?.content[0] as { text: string }
    const latestText = out[2]?.content[0] as { text: string }
    // 历史与最新使用同一模板,内容一致。
    expect(oldText.text).toBe('[用户粘贴的图片内容:一张猫的图片]')
    expect(latestText.text).toBe(oldText.text)
    expect(out.every((m) => m.content.every((b) => b.type !== 'image'))).toBe(true)
  })

  it('工具结果里的图片块同样转换(原生 read_image 的返回)', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [
      { role: 'user', content: [textBlock('看下这张截图')] },
      { role: 'assistant', content: [{ type: 'tool-call', callId: 'call-1', name: 'read_image', arguments: { file_path: 'a.png' } } as unknown as ContentBlock] },
      // 原生 read_image 的返回:文本信封 + ImageBlock。
      { role: 'tool', content: [textBlock('<path>a.png</path>'), imageBlock('sha256-tool-read') as unknown as ContentBlock] },
    ]

    const out = await convertPastedImages(ctx as never, messages, getOptions)

    // 文本信封保留,图片块换成描述文本;漏掉 tool 角色会让裸图片块进入
    // 下一次请求,被 pi-ai 适配器硬拒(does not support image input)。
    expect(out[2]?.content[0]).toStrictEqual(textBlock('<path>a.png</path>'))
    expect(out[2]?.content[1]).toStrictEqual({ type: 'text', text: '[用户粘贴的图片内容:一张猫的图片]' })
    expect(out.every((m) => m.content.every((b) => b.type !== 'image'))).toBe(true)
  })

  it('同一附件只读图一次:重复转换内容一致(确定性)', async () => {
    const { ctx, calls } = makeCtx()
    const continuation: Message[] = [
      { role: 'user', content: [imageBlock('sha256-turn') as unknown as ContentBlock] },
      { role: 'assistant', content: [textBlock('分析')] },
      { role: 'tool', content: [textBlock('(工具结果)')] },
    ]

    const first = await convertPastedImages(ctx as never, continuation, getOptions)
    const second = await convertPastedImages(ctx as never, continuation, getOptions)

    expect(calls[0]).toBe(1)
    expect(mockedAgyReadImage).toHaveBeenCalledTimes(1)
    // 两次转换输出完全一致(请求内容稳定 → prompt 缓存命中)。
    expect(second).toStrictEqual(first)
  })

  it('附件服务不可用时输出占位文本而不是抛错', async () => {
    const ctx = { get: () => undefined }
    const messages: Message[] = [{ role: 'user', content: [imageBlock('sha256-noservice') as unknown as ContentBlock] }]

    const out = await convertPastedImages(ctx as never, messages, getOptions)

    expect(out[0]?.content[0]).toStrictEqual(
      { type: 'text', text: '[用户粘贴的图片内容:[用户粘贴了一张图片,但附件服务不可用,图片无法读取]]' },
    )
    expect(mockedAgyReadImage).not.toHaveBeenCalled()
  })

  it('附件读取失败(空字节)时输出占位文本而不是抛错', async () => {
    const ctx = {
      get: (key: string) => key === 'attachments' ? { readImage: async () => ({ data: new Uint8Array(0) }) } : undefined,
    }
    const messages: Message[] = [{ role: 'user', content: [imageBlock('sha256-empty') as unknown as ContentBlock] }]

    const out = await convertPastedImages(ctx as never, messages, getOptions)

    expect(out[0]?.content[0]).toStrictEqual(
      { type: 'text', text: '[用户粘贴的图片内容:[用户粘贴了一张图片,但附件读取失败,图片无法读取]]' },
    )
    expect(mockedAgyReadImage).not.toHaveBeenCalled()
  })

  it('无图片的消息原样返回', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [
      { role: 'user', content: [textBlock('hello')] },
      { role: 'assistant', content: [textBlock('hi')] },
    ]

    const out = await convertPastedImages(ctx as never, messages, getOptions)

    expect(out).toStrictEqual(messages)
  })

  it('最新输入同时含文本和图片:文本保留,图片转换为统一模板', async () => {
    const { ctx } = makeCtx()
    const messages: Message[] = [{
      role: 'user',
      content: [textBlock('分析这张图的配色'), imageBlock('sha256-mixed') as unknown as ContentBlock],
    }]

    const out = await convertPastedImages(ctx as never, messages, getOptions)

    expect(out[0]?.content).toHaveLength(2)
    expect(out[0]?.content[0]).toStrictEqual(textBlock('分析这张图的配色'))
    expect(out[0]?.content[1]).toStrictEqual({ type: 'text', text: '[用户粘贴的图片内容:一张猫的图片]' })
  })
})

describe('readImageAgyEnabled:开关读取', async () => {
  const { readImageAgyEnabled } = await import('../src/settings.ts')

  it('未配置时默认开启', () => {
    const ctx = { get: () => undefined }
    expect(readImageAgyEnabled(ctx as never)).toBe(true)
  })

  it('settings 命名空间关闭时返回 false', () => {
    const ctx = { get: () => ({ get: (ns: string) => ns === 'agy' ? { readImageAgy: false } : undefined }) }
    expect(readImageAgyEnabled(ctx as never)).toBe(false)
  })

  it('settings 命名空间开启时返回 true', () => {
    const ctx = { get: () => ({ get: (ns: string) => ns === 'agy' ? { readImageAgy: true } : undefined }) }
    expect(readImageAgyEnabled(ctx as never)).toBe(true)
  })
})
