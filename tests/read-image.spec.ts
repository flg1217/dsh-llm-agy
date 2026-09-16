/**
 * read-image 单元测试(焦点:额外看图要求如何进入 AGY 提示词):
 * - 不传 `extra` 时提示词一字不改(中继结果按附件缓存,措辞即内容);
 * - 传入时作为"看图要求"追加,且会去掉首尾空白;
 * - 执行走公共 AGY 执行器(spawn + stream-json),超时由执行器控制。
 */
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import { Readable as ReadableStream } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { agyReadImage, agyReadImageAgyTool } from '../src/read-image.ts'

/** mock 子进程:测试不真正 spawn agy;只关心传给它的提示词与解析行为。 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

const mockedSpawn = vi.mocked(spawn)

/** 真实 AGY 输出 UTF-8 字节、执行器按 latin1 解码;测试要模拟同样的编码往返。 */
function latin1OfUtf8(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1')
}

/** 假 AGY 进程:吐出 result 成功事件(描述文本),然后关闭。 */
function fakeProc(response: string): EventEmitter & { stdout: Readable; kill: () => void } {
  const proc = new EventEmitter() as EventEmitter & { stdout: Readable; kill: () => void }
  proc.stdout = ReadableStream.from([
    `${JSON.stringify({ event: 'step_update' })}\n`,
    `${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: latin1OfUtf8(response) } })}\n`,
  ])
  proc.kill = (): void => {}
  proc.stdout.on('end', () => setTimeout(() => proc.emit('close', 0, null), 10))
  return proc
}

/** 取出最近一次调用传给 agy 的 `-p` 提示词。 */
function lastPrompt(): string {
  const args = mockedSpawn.mock.calls.at(-1)?.[1] as string[] | undefined
  const index = args?.indexOf('-p') ?? -1
  return index >= 0 ? (args?.[index + 1] ?? '') : ''
}

beforeEach(() => {
  mockedSpawn.mockClear()
  mockedSpawn.mockImplementation(() => fakeProc('一张表格') as unknown as ReturnType<typeof spawn>)
})

describe('agyReadImage:额外看图要求', () => {
  it('未传要求时保持原有提示词', async () => {
    await agyReadImage('agy', '', 'a.png')

    expect(lastPrompt()).toBe(
      '请查看这张图片并描述你看到的内容:a.png。给出准确、详细的中文描述,回答问题时直接依据图片内容。',
    )
  })

  it('传入要求时作为“看图要求”追加到提示词', async () => {
    await agyReadImage('agy', '', 'a.png', '只提取表格里的数字')

    const prompt = lastPrompt()
    expect(prompt).toContain('看图要求:只提取表格里的数字')
    expect(prompt).toContain('a.png')
  })

  it('空白要求等同于不传,不产生“看图要求”段落', async () => {
    await agyReadImage('agy', '', 'a.png', '   ')

    expect(lastPrompt()).not.toContain('看图要求')
  })

  it('解析 result.response 为描述文本', async () => {
    const text = await agyReadImage('agy', '', 'a.png')
    expect(text).toBe('一张表格')
  })

  it('AGY 报错时抛出明确错误', async () => {
    mockedSpawn.mockImplementation(() => {
      const proc = fakeProc('')
      const original = proc.stdout
      proc.stdout = ReadableStream.from([
        `${JSON.stringify({ event: 'result', result: { status: 'ERROR', error: latin1OfUtf8('模型不可用') } })}\n`,
      ])
      original.destroy()
      return proc
    })
    await expect(agyReadImage('agy', '', 'a.png')).rejects.toThrow(/模型不可用|调用失败/)
  })
})

/** 最小 PNG 文件(只有魔数;saveImage 是 mock,不校验真实像素)。 */
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
}

describe('read_image_agy 工具:UI 呈现附件提交', () => {
  const ref = {
    attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 12, width: 1, height: 1, name: 'fixture.png',
  }
  let dir: string
  let diskPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agy-read-image-spec-'))
    diskPath = join(dir, 'fixture.png')
    writeFileSync(diskPath, pngBytes())
  })

  function makeAttachments(saveImage?: () => Promise<unknown>) {
    return {
      imageLimits: { maxImageBytes: 1024 * 1024 },
      ...(saveImage === undefined ? {} : { saveImage: vi.fn(saveImage) }),
    }
  }

  it('读图成功后提交图片到附件存储,值携带 image 引用', async () => {
    const attachments = makeAttachments(async () => ref)
    const tool = agyReadImageAgyTool(() => ({ command: 'agy', proxy: '' }), () => attachments)
    const value = await tool.execute({ file_path: diskPath }, { signal: undefined } as never)

    expect(value.description).toBe('一张表格')
    expect(value.path).toBe(diskPath)
    expect(value.image).toEqual(ref)
    expect(attachments.saveImage).toHaveBeenCalledWith({
      data: expect.any(Uint8Array), mediaType: 'image/png', name: 'fixture.png',
    })
    expect(tool.output.presentationMeta?.({}, value)).toEqual({ path: diskPath, image: ref })
    // 内容为 [描述信封, 图片块]:图片块供会话附件授权(画廊)+ 会话历史;
    // 纯文本路由由 LlmRuntime 投影为占位文本,适配器不受影响。
    expect(tool.output.render({}, value)).toEqual([
      { type: 'text', text: expect.stringContaining('<path>') },
      { type: 'image', attachment: ref },
    ])
  })

  it('saveImage 失败跳过并落日志:值无 image 字段,工具不报错', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const attachments = makeAttachments(async () => { throw new Error('IMAGE_TOO_LARGE') })
    const tool = agyReadImageAgyTool(() => ({ command: 'agy', proxy: '' }), () => attachments)
    const value = await tool.execute({ file_path: diskPath }, { signal: undefined } as never)

    expect(value.description).toBe('一张表格')
    expect(value.image).toBeUndefined()
    expect(tool.output.presentationMeta?.({}, value)).toEqual({ path: diskPath })
    // 无图片引用时内容只有描述信封(无 image block)。
    expect(tool.output.render({}, value)).toEqual([
      { type: 'text', text: expect.stringContaining('<path>') },
    ])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('IMAGE_TOO_LARGE'))
    warn.mockRestore()
  })

  it('附件服务未挂载时不提交呈现引用', async () => {
    const tool = agyReadImageAgyTool(() => ({ command: 'agy', proxy: '' }), () => undefined)
    const value = await tool.execute({ file_path: diskPath }, { signal: undefined } as never)

    expect(value.description).toBe('一张表格')
    expect(value.image).toBeUndefined()
  })

  it('非图片扩展名且魔数不符时不提交', async () => {
    const textPath = join(dir, 'note.txt')
    writeFileSync(textPath, Buffer.from('plain text, not an image'))
    const attachments = makeAttachments(async () => ref)
    const tool = agyReadImageAgyTool(() => ({ command: 'agy', proxy: '' }), () => attachments)
    const value = await tool.execute({ file_path: textPath }, { signal: undefined } as never)

    expect(value.description).toBe('一张表格')
    expect(value.image).toBeUndefined()
    expect(attachments.saveImage).not.toHaveBeenCalled()
  })

  it('粘贴附件引用路径:readImage 读字节 → AGY 读图 → 提交呈现引用', async () => {
    const attachments = makeAttachments(async () => ref)
    const readImage = vi.fn(async () => ({ data: pngBytes(), mediaType: 'image/png' }))
    attachments.readImage = readImage
    const tool = agyReadImageAgyTool(() => ({ command: 'agy', proxy: '' }), () => attachments)
    const value = await tool.execute({ file_path: 'sha256:abc' }, { signal: undefined } as never)

    expect(readImage).toHaveBeenCalledWith({ attachmentId: 'sha256:abc' }, undefined)
    expect(value.path).toBe('sha256:abc')
    expect(value.description).toBe('一张表格')
    expect(value.image).toEqual(ref)
    // 呈现引用的 name 由媒体类型推导(附件引用没有文件名)。
    expect(attachments.saveImage).toHaveBeenCalledWith({
      data: expect.any(Uint8Array), mediaType: 'image/png', name: 'image.png',
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
})
