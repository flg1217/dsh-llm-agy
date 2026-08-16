/**
 * AGY 设置区与命令:
 * - installSettingsSection 注册 `agy` namespace,设置面板自动出现 AntiGravity 配置表单。
 * - /agy 命令:status(检测安装/登录)、test(发起回复 hi 的测试)、help。
 * @module llm-agy/settings
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const AGY_SETTINGS_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;
/** AGY 设置表单 schema(schemastery Schema;settings.register 会把 schema 当函数调用)。 */
export declare const AgySettingsConfig: z<Schemastery.ObjectS<{
    command: z<string, string>;
    model: z<string, string>;
    effort: z<string, string>;
    proxy: z<string, string>;
}>, Schemastery.ObjectT<{
    command: z<string, string>;
    model: z<string, string>;
    effort: z<string, string>;
    proxy: z<string, string>;
}>>;
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
/** 官方安装命令(供复制)。 */
export declare const INSTALL_COMMANDS: string[];
/** 工具说明列表。 */
export declare const TOOL_DESCRIPTIONS: {
    name: string;
    desc: string;
}[];
/** 注册设置区、命令与模型探测通道(客户端面板按钮走 api.llm.discoverModels,不落会话)。 */
export declare function registerAgySettings(ctx: Context): void;
