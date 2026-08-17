/**
 * 全局看图分工提示(delegation guide):注入到所有会话的系统提示词。
 *
 * 内容:看图必须直接用 read_image_agy 工具;UI 实现/前端改造才用
 * subagent_agy_ui(如存在);不因看图委派子代理。
 *
 * 受 agy settings namespace 的 `delegationGuide` 开关控制(设置面板可切);
 * 关闭时不注入,原生行为。
 * @module llm-agy/delegate-guide
 */

import type { Context } from '@deepseek-ai/cordis'

/** 读取 delegationGuide 开关(默认 true)。 */
export function delegationGuideEnabled(ctx: Context): boolean {
  const settings = ctx.get('settings') as { get?: (ns: string) => { delegationGuide?: boolean } | undefined } | undefined
  const value = settings?.get?.('agy')
  return value?.delegationGuide ?? true
}

/** 注册全局看图分工 section。 */
export function installDelegationGuide(ctx: Context): void {
  if (!delegationGuideEnabled(ctx)) return
  try {
    const systemPrompt = ctx.get('systemPrompt') as {
      section?: (options: { name: string; order: number; text: string }) => void
    } | undefined
    if (!systemPrompt?.section) return
    systemPrompt.section({
      name: 'agy:tool-policy',
      order: 0,
      text: `Tool use policy:
- Analyze images directly with read_image_agy (works with text-only models). Never delegate image reading to a subagent.
- Use subagent_agy_ui only for frontend implementation tasks.
- Split complex tasks into independent subagents; run them in parallel.
- Do not poll background subagents; the runtime notifies you via callback when they settle.
- Provide full context (paths, goals, constraints, acceptance criteria) for every delegation.`,
    })
  } catch { /* 无 systemPrompt 服务则跳过 */ }
}
