/**
 * llm-agy 插件入口:注册 AGY(Antigravity CLI)模型适配器 + 搜索 provider。
 * 对齐 llm-deepseek/index.ts 的结构:Config 定义 + apply 注册 provider 路由。
 * @module llm-agy
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "llm-agy";
export declare const inject: string[];
/** 设置输入面(profile patch 条目 config / 表单写入的原始值;缺省走 schema 默认)。 */
export interface AgyConfigInput {
    command?: string;
    model?: string;
    effort?: string;
    proxy?: string;
    delegationGuide?: boolean;
    readImageAgy?: boolean;
    searchOverride?: boolean;
    dshExecutor?: boolean;
    extraArgs?: string[];
    registerSubagentTools?: boolean;
}
/**
 * 本插件配置面(profile 条目 id = `llm-agy`;即设置表单)。
 * 前 8 个字段 volatile = 设置面板可编辑、读取即活引用;后两个仅 profile
 * patch 可编辑(不进表单,普通配置)。
 */
export interface Config {
    command: Volatile<string>;
    model: Volatile<string>;
    effort: Volatile<string>;
    proxy: Volatile<string>;
    delegationGuide: Volatile<boolean>;
    readImageAgy: Volatile<boolean>;
    searchOverride: Volatile<boolean>;
    dshExecutor: Volatile<boolean>;
    extraArgs: string[];
    registerSubagentTools: boolean;
}
export declare const Config: z<AgyConfigInput, Config>;
export declare function apply(ctx: Context, config: Config): void;
