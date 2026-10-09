/**
 * AGY 设置区:
 * - AgySettings:面板可编辑字段的活引用(由 index.ts 导出的 Config schema 解析,
 *   profile 条目 id `llm-agy` 即设置命名空间)。
 * - 模型探测通道:客户端面板按钮走自建路由(见 models-route.ts);官方
 *   discoverModels 通道一并保留(settingsNs = 条目 id)。
 * @module llm-agy/settings
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
/** 设置命名空间 = profile 条目 id。 */
export declare const AGY_SETTINGS_NAMESPACE = "llm-agy";
/** 面板可编辑字段(volatile 活引用;由 index.ts 的 Config schema 解析)。 */
export interface AgySettings {
    command: Volatile<string>;
    model: Volatile<string>;
    effort: Volatile<string>;
    proxy: Volatile<string>;
    delegationGuide: Volatile<boolean>;
    readImageAgy: Volatile<boolean>;
    searchOverride: Volatile<boolean>;
    dshExecutor: Volatile<boolean>;
}
/** 检测 AGY 是否已安装(命令存在)。 */
export declare function agyInstalled(command: string): boolean;
/**
 * 检测 AGY 登录状态。
 * 注意:`agy auth status` 不是有效命令(会挂起),不能用于检测。
 * 可靠依据:AGY 数据目录存在 + 已有会话记录(说明完成过登录与使用)。
 */
export declare function agyLoggedIn(): boolean;
/** 发起真实测试:让 AGY 回答一个真实问题,返回实际回复内容。 */
export declare function agyTest(command: string, proxy: string): Promise<{
    ok: boolean;
    output: string;
}>;
/**
 * 注册模型探测通道(客户端面板按钮走自建路由,不落会话)。
 * @param ctx - 插件上下文。
 * @param settings - 面板字段活引用(命令/代理/模型实时读,面板改动即时生效)。
 */
export declare function registerAgySettings(ctx: Context, settings: AgySettings): void;
