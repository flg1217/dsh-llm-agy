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
import type { Context } from '@deepseek-ai/cordis';
/** 读取 delegationGuide 开关(默认 true)。 */
export declare function delegationGuideEnabled(ctx: Context): boolean;
/** 注册全局子代理委派提示 section。 */
export declare function installDelegationGuide(ctx: Context): void;
