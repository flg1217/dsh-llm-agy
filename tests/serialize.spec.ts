/**
 * prompt 序列化的续跑补发与运行时约束回归测试。
 *
 * 现场(2026-09-18):
 * - AGY 在 print 模式用 Bash run_in_background 启动 Playwright 后立即输出
 *   "已在后台启动,完成后继续"并结束回合——一次性 print 进程没有"后台任务
 *   完成后唤醒"的循环,子代理对话随之提前收尾;
 * - 用户发"继续"后,适配器把全量历史(含 System instructions)重新序列化,
 *   AGY 把历史记录当新任务从头跑(重读 agy-task 临时文件、重新 Glob/列目录)。
 *
 * 修复:抄 dsh-subagent-codebuddy 的 dsh↔外部系统转换模块——按发送锚点补发
 * 增量(不重发全量)、跳过 AGY 自己的轮次;锚点丢失/压缩 checkpoint 时只发
 * 最后一条用户输入兜底;每次 prompt 携带运行时约束(禁后台任务)。
 */
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { buildPrompt, lastUserPrompt, resumeReplayPrompt } from '../src/serialize.ts'

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

/** 带 id 与来源的消息构造(锚点/own/checkpoint 判定用)。 */
function userMessage(id: string, text: string): Message {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as unknown as Message
}

function ownAssistant(id: string, text: string): Message {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'agy', model: 'gemini-3.8-high' },
  } as unknown as Message
}

/** 压缩 checkpoint(dsh 原生与镜像压缩的 replace 消息,source 同形)。 */
function compactCheckpoint(id: string): Message {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: '[上下文已压缩]' }],
    source: { kind: 'plugin', plugin: 'compact' },
  } as unknown as Message
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

  it('首轮(单条消息)不带延续说明,多轮全量重发带且位于历史之前', async () => {
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

describe('resumeReplayPrompt:锚点增量补发(与 codebuddy 转换模块同源)', () => {
  it('锚点命中:只补发锚点之后的增量,AGY 自己的轮次不重发', async () => {
    const messages = [
      userMessage('m1', '原始任务'),
      ownAssistant('m2', '我正在做'),
      userMessage('m3', '插一句:优先修 bug'),
      ownAssistant('m4', '好的'),
      userMessage('m5', '继续'),
    ]
    const { prompt, cleanup } = await resumeReplayPrompt(ctx, messages, 1, 'm2')
    leftOvers.push(cleanup)
    expect(prompt).toContain('插一句')
    expect(prompt).toContain('继续')
    expect(prompt).not.toContain('原始任务')
    expect(prompt).not.toContain('我正在做')
    expect(prompt).not.toContain('好的')
  })

  it('锚点之后其他模型的回答被完整补发(不当作 own 跳过)', async () => {
    const messages: Message[] = [
      userMessage('m1', '原始任务'),
      ownAssistant('m2', 'agy 自己的回答'),
      {
        id: 'm3',
        role: 'assistant',
        content: [{ type: 'text', text: '别的模型的回答' }],
        source: { kind: 'model', provider: 'deepseek', model: 'v4' },
      } as unknown as Message,
      userMessage('m4', '切回后的新输入'),
    ]
    const { prompt, cleanup } = await resumeReplayPrompt(ctx, messages, 1, 'm1')
    leftOvers.push(cleanup)
    expect(prompt).toContain('别的模型的回答')
    expect(prompt).toContain('切回后的新输入')
    expect(prompt).not.toContain('agy 自己的回答')
  })

  it('锚点被压缩移除:不整体重发,只发最后一条用户输入兜底', async () => {
    const messages = [
      compactCheckpoint('c1'),
      userMessage('m2', '继续'),
    ]
    const { prompt, cleanup } = await resumeReplayPrompt(ctx, messages, 1, 'm-gone')
    leftOvers.push(cleanup)
    expect(prompt).toContain('继续')
    expect(prompt).not.toContain('上下文已压缩')
  })

  it('数量锚在已发区内遇到压缩 checkpoint:不按数量锚切片,只发最后一条用户输入', async () => {
    const messages = [
      userMessage('m1', '原始任务'),
      compactCheckpoint('c1'),
      ownAssistant('m3', 'own 的回答'),
      userMessage('m4', '继续'),
    ]
    const { prompt, cleanup } = await resumeReplayPrompt(ctx, messages, 3)
    leftOvers.push(cleanup)
    expect(prompt).toContain('继续')
    expect(prompt).not.toContain('原始任务')
    expect(prompt).not.toContain('own 的回答')
  })

  it('锚点之后全是 AGY 自己的轮次 → CONTINUE_PROMPT 兜底', async () => {
    const messages = [
      userMessage('m1', '任务'),
      ownAssistant('m2', '做完了'),
    ]
    const { prompt, cleanup } = await resumeReplayPrompt(ctx, messages, 1, 'm1')
    leftOvers.push(cleanup)
    expect(prompt).toContain('继续完成之前未完成的任务')
    expect(prompt).not.toContain('做完了')
  })

  it('无任何锚点 → 只发最后一条用户输入(兜底)', async () => {
    const messages = [
      userMessage('m1', '原始任务'),
      ownAssistant('m2', 'own 的回答'),
      userMessage('m3', '继续'),
    ]
    const { prompt, cleanup } = await resumeReplayPrompt(ctx, messages, undefined)
    leftOvers.push(cleanup)
    expect(prompt).toContain('继续')
    expect(prompt).not.toContain('原始任务')
  })
})

describe('lastUserPrompt:精确取用户输入', () => {
  it('插件注入的 user 消息排在用户输入之后也不会顶掉它', async () => {
    const messages = [
      userMessage('m1', '用户真输入'),
      {
        id: 'p1',
        role: 'user',
        content: [{ type: 'text', text: '技能目录提醒' }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-skill' },
      } as unknown as Message,
    ]
    const { prompt, cleanup } = await lastUserPrompt(ctx, messages)
    leftOvers.push(cleanup)
    expect(prompt).toContain('用户真输入')
    expect(prompt).not.toContain('技能目录提醒')
  })

  it('没有用户输入时发 CONTINUE_PROMPT', async () => {
    const { prompt, cleanup } = await lastUserPrompt(ctx, [ownAssistant('m1', '只有 own')])
    leftOvers.push(cleanup)
    expect(prompt).toContain('继续完成之前未完成的任务')
  })
})
