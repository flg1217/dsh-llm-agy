/**
 * AGY 独立搜索工具(agy_web_search):searchOverride 关闭时注册。
 * 不占全局 web 搜索缝(ctx.web),作为独立工具直接调用 AgySearchProvider,
 * 避免与其它搜索 provider(如 web-search-openai)注册进同一缝造成
 * WEB_PROVIDER_AMBIGUOUS 冲突。
 * @module llm-agy/search-tool
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * 注册 agy_web_search 独立工具(含系统提示 section)。
 * @returns disposer;插件运行时被注销,支持开关热切换。
 */
export declare function registerAgySearchTool(ctx: Context, options: AgySearchProviderOptions): (() => void) | undefined;
/** AgySearchProvider 构造参数(与 search.ts 的 AgySearchOptions 同构)。 */
export interface AgySearchProviderOptions {
    command: string;
    model: string;
    effort: string;
    proxy?: string;
}
