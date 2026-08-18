/**
 * 全局子代理委派提示(delegation guide):注入到所有会话的系统提示词。
 *
 * 内容:subagent_agy_ui 用途、并行拆分、不轮询后台子代理、给足委派上下文。
 * 看图规则不再注入——用户粘贴图片时,image-paste 中继已经注入
 * "请调用 read_image_agy"提醒,无需常驻提示。
 *
 * 受 agy settings namespace 的 `delegationGuide` 开关控制(设置面板可切);
 * 关闭时不注入,原生行为。
 * @module llm-agy/delegate-guide
 */
/** 读取 delegationGuide 开关(默认 true)。 */
export function delegationGuideEnabled(ctx) {
    const settings = ctx.get('settings');
    const value = settings?.get?.('agy');
    return value?.delegationGuide ?? true;
}
/** 注册全局子代理委派提示 section。 */
export function installDelegationGuide(ctx) {
    if (!delegationGuideEnabled(ctx))
        return;
    try {
        const systemPrompt = ctx.get('systemPrompt');
        if (!systemPrompt?.section)
            return;
        systemPrompt.section({
            name: 'agy:tool-policy',
            order: 0,
            text: `Tool use policy:
- Use subagent_agy_ui only for frontend implementation tasks.
- Split complex tasks into independent subagents; run them in parallel.
- Do not poll background subagents; the runtime notifies you via callback when they settle.
- Provide full context (paths, goals, constraints, acceptance criteria) for every delegation.`,
        });
    }
    catch { /* 无 systemPrompt 服务则跳过 */ }
}
