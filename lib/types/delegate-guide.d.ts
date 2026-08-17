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
import type { Context } from '@deepseek-ai/cordis';
/** 读取 delegationGuide 开关(默认 true)。 */
export declare function delegationGuideEnabled(ctx: Context): boolean;
/** 注册全局看图分工 section。 */
export declare function installDelegationGuide(ctx: Context): void;
