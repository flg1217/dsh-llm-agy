/**
 * read-image 单元测试(焦点:额外看图要求如何进入 AGY 提示词):
 * - 不传 `extra` 时提示词一字不改(中继结果按附件缓存,措辞即内容);
 * - 传入时作为"看图要求"追加,且会去掉首尾空白;
 * - 执行走公共 AGY 执行器(spawn + stream-json),超时由执行器控制。
 */
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import { Readable as ReadableStream } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { agyReadImage } from '../src/read-image.ts'

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
