/**
 * llm-agy 插件入口:注册 AGY(Antigravity CLI)模型适配器 + 搜索 provider。
 * 对齐 llm-deepseek/index.ts 的结构:Config 定义 + apply 注册 provider 路由。
 * @module llm-agy
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "llm-agy";
export declare const inject: string[];
export interface Config {
    /** agy 可执行文件,默认 `agy`。 */
    command?: string;
    /** 传给 `--model` 的 AGY 模型。 */
    model?: string;
    /** 传给 `--effort` 的 AGY 推理强度。 */
    effort?: string;
    /** 追加的额外 AGY 参数。 */
    extraArgs?: string[];
    /** AGY 资格检查/API 流量代理,默认 `http://127.0.0.1:7890`;空字符串禁用。 */
    proxy?: string;
    /** 注册为 dsh web 搜索 provider 的 id,默认 `agy`;空字符串禁用搜索接入。 */
    searchProviderId?: string;
    /** 是否注册 `subagent_agy_ui` / `subagent_agy_vision` 子代理工具(默认开启)。 */
    registerSubagentTools?: boolean;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
