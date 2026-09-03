/**
 * AGY 设置区:
 * - installSettingsSection 注册 `agy` namespace,设置面板自动出现 AntiGravity 配置表单。
 * - 模型探测通道:客户端面板按钮走 api.llm.discoverModels(状态/测试)。
 * @module llm-agy/settings
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const AGY_SETTINGS_NAMESPACE = "agy";
/** AGY 设置表单 schema(schemastery Schema;settings.register 会把 schema 当函数调用)。 */
export declare const AgySettingsConfig: z<Schemastery.ObjectS<{
    command: z<string, string>;
    model: z<string, string>;
    effort: z<string, string>;
    proxy: z<string, string>;
    /** 全局注入"子代理委派"系统提示(subagent_agy_ui 用途与委派规则)。 */
    delegationGuide: z<boolean, boolean>;
    /** 是否注册 AGY 看图工具与图片粘贴中继(默认开启)。 */
    readImageAgy: z<boolean, boolean>;
    /** 是否用 AGY 搜索接管全局 web_search 工具(默认开启);关闭时仅注册独立的 agy_web_search 工具。 */
    searchOverride: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    command: z<string, string>;
    model: z<string, string>;
    effort: z<string, string>;
    proxy: z<string, string>;
    /** 全局注入"子代理委派"系统提示(subagent_agy_ui 用途与委派规则)。 */
    delegationGuide: z<boolean, boolean>;
    /** 是否注册 AGY 看图工具与图片粘贴中继(默认开启)。 */
    readImageAgy: z<boolean, boolean>;
    /** 是否用 AGY 搜索接管全局 web_search 工具(默认开启);关闭时仅注册独立的 agy_web_search 工具。 */
    searchOverride: z<boolean, boolean>;
}>>;
/** 读取 readImageAgy 开关(默认开启)。 */
export declare function readImageAgyEnabled(ctx: Context): boolean;
/** 读取 searchOverride 开关(默认开启):开 = 注册进全局 web 搜索缝,关 = 仅独立 agy_web_search 工具。 */
export declare function searchOverrideEnabled(ctx: Context): boolean;
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
/** 注册设置区与模型探测通道(客户端面板按钮走 api.llm.discoverModels,不落会话)。 */
export declare function registerAgySettings(ctx: Context): () => Record<string, string>;
