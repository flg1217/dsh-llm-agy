/**
 * prompt 序列化的运行时约束回归测试。
 *
 * 现场(2026-09-18):AGY 在 print 模式用 Bash run_in_background 启动
 * Playwright 后立即输出"已在后台启动,完成后继续"并结束回合——一次性
 * print 进程没有"后台任务完成后唤醒"的循环,子代理对话随之提前收尾;
 * 用户发"继续"后,全量历史(含 System instructions)被重新当任务从头跑
 * (重读 agy-task 临时文件、重新 Glob/列目录)。
 *
 * 锁死的行为:
 * - 每次生成的 prompt 都带运行时约束(禁后台任务、前台等待);
 * - 首轮(单条消息)不带延续说明;多轮续跑带延续说明,且在历史消息之前;
 * - 超长 prompt 落临时文件时,约束与延续说明一并进文件,cleanup 删文件。
 */
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { buildPrompt } from '../src/serialize.ts'

/** 无附件服务的最小 ctx。 */
const ctx = { get: (): undefined => undefined } as unknown as Context

/** 构造 GenerateOptions:content 支持 string 或块数组。 */
function opts(system: string | undefined, messages: Array<{ role: 'user' | 'assistant'; content: string }>): GenerateOptions {
  return {
    ...(system !== undefined ? { system } : {}),
    messages: messages.map(message => ({
      role: message.role,
      content: [{ type: 'text', text: message.content }],
    })),
  } as unknown as GenerateOptions
}

const leftOvers: Array<() => void> = []
afterEach(() => {
  for (const fn of leftOvers.splice(0)) fn()
})

describe('buildPrompt:运行时约束与延续说明', () => {
  it('每次生成的 prompt 都带禁后台任务的运行时约束', async () => {
    const { prompt, cleanup } = await buildPrompt(ctx, opts(undefined, [
      { role: 'user', content: '跑一下测试' },
    ]))
    leftOvers.push(cleanup)
    expect(prompt).toContain('非交互一次性调用')
    expect(prompt).toContain('run_in_background')
    expect(prompt).toContain('前台运行')
    // 约束在任务消息之前。
    expect(prompt.indexOf('运行环境约束')).toBeLessThan(prompt.indexOf('跑一下测试'))
  })

  it('首轮(单条消息)不带延续说明,多轮续跑带且位于历史之前', async () => {
    const first = await buildPrompt(ctx, opts(undefined, [
      { role: 'user', content: '任务' },
    ]))
    leftOvers.push(first.cleanup)
    expect(first.prompt).not.toContain('同一任务的延续')

    const resumed = await buildPrompt(ctx, opts(undefined, [
      { role: 'user', content: '任务' },
      { role: 'assistant', content: '已完成一半' },
      { role: 'user', content: '继续' },
    ]))
    leftOvers.push(resumed.cleanup)
    expect(resumed.prompt).toContain('同一任务的延续')
    expect(resumed.prompt.indexOf('同一任务的延续')).toBeLessThan(resumed.prompt.indexOf('已完成一半'))
    expect(resumed.prompt).toContain('不要重做已完成的部分')
  })

  it('超长 prompt 落临时文件:约束与延续说明一并进文件,cleanup 删除', async () => {
    const long = '历史记录。'.repeat(6000) // > 26K 阈值
    const { prompt, cleanup } = await buildPrompt(ctx, opts('子代理系统提示', [
      { role: 'user', content: long },
      { role: 'assistant', content: '做过一些工作' },
      { role: 'user', content: '继续' },
    ]))
    leftOvers.push(cleanup)
    // 引用 prompt 本身不含历史,只指向任务文件。
    expect(prompt).toMatch(/请先读取任务描述文件并完整阅读: .+agy-task-.+\.txt/)
    expect(prompt).not.toContain('做过一些工作')
    const file = /[^\s"']*agy-task-.+\.txt/.exec(prompt)?.[0] ?? ''
    expect(existsSync(file)).toBe(true)
    // 文件内容:system → 约束 → 延续说明 → 历史。
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(file, 'utf8')
    expect(content).toContain('System instructions:')
    expect(content).toContain('非交互一次性调用')
    expect(content).toContain('同一任务的延续')
    expect(content.indexOf('同一任务的延续')).toBeLessThan(content.indexOf('做过一些工作'))
  })

  it('cleanup 删除任务文件', async () => {
    const { prompt, cleanup } = await buildPrompt(ctx, opts(undefined, [
      { role: 'user', content: 'x'.repeat(27_000) },
    ]))
    const file = /[^\s"']*agy-task-.+\.txt/.exec(prompt)?.[0] ?? ''
    expect(file).not.toBe('')
    await cleanup()
    expect(existsSync(file)).toBe(false)
  })
})
