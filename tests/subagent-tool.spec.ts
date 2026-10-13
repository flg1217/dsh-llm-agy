/**
 * subagent_agy_ui 委派工具单元测试(此前零覆盖)。
 *
 * 锁死的行为:
 * - 默认后台(delivery:'parent'):startActivation 收到完整请求,返回 subagentId;
 * - run_in_background:false 前台(delivery:'caller'):等待 activation.result,
 *   输出进返回值;
 * - 非 completed 停止原因映射为明确错误(aborted/error/max-tokens/refusal)
 *   并附上已产出的部分文本;dispose 始终释放;
 * - model 参数覆盖插件默认模型;exec.agent 缺失报错;
 * - systemPrompt section 仅在工具可见时输出(注入完整上下文指引)。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import { registerSubagentTool } from '../src/subagent-tool.ts'

interface ToolDef {
  readonly name?: string
  readonly execute?: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

interface SectionDef {
  readonly name?: string
  readonly order?: number
  readonly text?: unknown
}

/** 捕获工具与 section 注册的假 ctx + 假 subagents 服务。 */
function setup(options?: {
  result?: { stopReason: string; output: Array<{ type: 'text'; text: string }> }
  failStart?: Error
}): {
  tool: ToolDef | undefined
  section: SectionDef | undefined
  startActivation: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  toolRegistered: { value: boolean }
} {
  let tool: ToolDef | undefined
  let section: SectionDef | undefined
  const toolRegistered = { value: true }
  const dispose = vi.fn(async () => {})
  const activation = {
    childId: 'child-1',
    result: Promise.resolve(options?.result ?? { stopReason: 'completed', output: [{ type: 'text', text: '工作完成' }] }),
    dispose,
  }
  const startActivation = vi.fn(async () => {
    if (options?.failStart !== undefined) throw options.failStart
    return activation
  })
  const ctx = {
    tools: {
      register: (definition: ToolDef): (() => void) => {
        tool = definition
        return () => { toolRegistered.value = false }
      },
      get: (): unknown => (toolRegistered.value ? tool : undefined),
    },
    subagents: { startActivation },
    systemPrompt: {
      section: (s: SectionDef): (() => void) => {
        section = s
        return () => {}
      },
    },
  } as unknown as Context
  registerSubagentTool(ctx, {
    provider: 'spawn',
    toolName: 'subagent_agy_ui',
    agentOptions: { provider: 'agy', model: 'gemini-3.8-high' },
    description: '委派前端实现任务',
    promptDescription: '完整任务说明',
  })
  return { tool, section, startActivation, dispose, toolRegistered }
}

/** 调用方上下文:父 agent 与信号。 */
function exec(promptAgent = true): { agent?: object; signal: AbortSignal } {
  return {
    ...promptAgent ? { agent: { id: 'parent-agent' } } : {},
    signal: new AbortController().signal,
  }
}

describe('subagent_agy_ui:后台(continuable)分支', () => {
  it('默认后台:startActivation(delivery:parent)收到请求并返回 subagentId', async () => {
    const { tool, startActivation } = setup()
    const value = await tool?.execute?.({ description: '做页面', prompt: '实现登录页' }, exec())
    expect(value).toEqual({ kind: 'continuable', subagentId: 'child-1' })
    const spec = startActivation.mock.calls[0]?.[0] as {
      provider: string
      label: string
      delivery: string
      request: { prompt: Array<{ type: string; text: string }>; agentOptions: { model: string }; parent: unknown }
      signal: AbortSignal
    }
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('做页面')
    expect(spec.delivery).toBe('parent')
    expect(spec.request.prompt).toEqual([{ type: 'text', text: '实现登录页' }])
    expect(spec.request.agentOptions.model).toBe('gemini-3.8-high')
    expect(spec.request.parent).toEqual({ id: 'parent-agent' })
  })

  it('model 参数覆盖插件默认模型(不改默认对象)', async () => {
    const { tool, startActivation } = setup()
    await tool?.execute?.({ description: 'x', prompt: 'y', model: 'gemini-3.8-flash-high' }, exec())
    const spec = startActivation.mock.calls[0]?.[0] as { request: { agentOptions: { model: string } } }
    expect(spec.request.agentOptions.model).toBe('gemini-3.8-flash-high')
  })

  it('exec.agent 缺失时明确报错(不静默降级)', async () => {
    const { tool, startActivation } = setup()
    await expect(tool?.execute?.({ description: 'x', prompt: 'y' }, exec(false)))
      .rejects.toThrow('requires a calling agent')
    expect(startActivation).not.toHaveBeenCalled()
  })
})

describe('subagent_agy_ui:前台(run_in_background:false)分支', () => {
  it('等待 activation.result,输出进返回值,dispose 释放', async () => {
    const { tool, startActivation, dispose } = setup()
    const value = await tool?.execute?.(
      { description: '做页面', prompt: '实现登录页', run_in_background: false },
      exec(),
    )
    expect(startActivation).toHaveBeenCalledTimes(1)
    const spec = startActivation.mock.calls[0]?.[0] as { delivery: string }
    expect(spec.delivery).toBe('caller')
    expect(value).toEqual({ kind: 'foreground', runId: 'child-1', output: [{ type: 'text', text: '工作完成' }] })
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('aborted:抛出取消错误,dispose 仍释放', async () => {
    const { tool, dispose } = setup({ result: { stopReason: 'aborted', output: [] } })
    await expect(tool?.execute?.(
      { description: 'x', prompt: 'y', run_in_background: false },
      exec(),
    )).rejects.toThrow('subagent run was cancelled')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('max-tokens:错误附上已产出的部分文本', async () => {
    const { tool } = setup({
      result: { stopReason: 'max-tokens', output: [{ type: 'text', text: '做到一半的内容' }] },
    })
    await expect(tool?.execute?.(
      { description: 'x', prompt: 'y', run_in_background: false },
      exec(),
    )).rejects.toThrow(/token limit[\s\S]*做到一半的内容/)
  })

  it('refusal:明确的任务拒绝错误', async () => {
    const { tool } = setup({ result: { stopReason: 'refusal', output: [] } })
    await expect(tool?.execute?.(
      { description: 'x', prompt: 'y', run_in_background: false },
      exec(),
    )).rejects.toThrow('subagent declined the task')
  })
})

describe('subagent_agy_ui:系统提示 section', () => {
  it('工具可见时输出委派指引,含工具名与后台优先/并行/上下文要求', () => {
    const { section } = setup()
    expect(section?.name).toBe('tool:subagent_agy_ui')
    const text = (section?.text as (context: { scope: unknown }) => string)({ scope: undefined })
    expect(text).toContain('subagent_agy_ui')
    expect(text).toContain('background by default')
    expect(text).toContain('run_in_background: false')
    expect(text).toContain('model list tool') // 非默认模型先查列表再传精确 id
  })

  it('工具不可见(已注销)时 section 输出为空', () => {
    const { section, toolRegistered } = setup()
    toolRegistered.value = false
    const text = (section?.text as (context: { scope: unknown }) => string)({ scope: undefined })
    expect(text).toBe('')
  })
})
