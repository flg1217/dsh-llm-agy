/**
 * AGY 搜索 provider:把 AGY 的 search_web 工具接入 dsh 的 ctx.web 搜索框架。
 * 对齐 dsh-web-search-deepseek/provider 的结构:
 * - available() 只做本地可用性检查(不联网);
 * - search() spawn AGY 执行一次搜索,解析 result.response 提取 sources。
 *
 * 限制(实测):
 * - AGY 的 search_web 不通过 stream-json 暴露结构化结果(tool_info.output 为空),
 *   只有 result.response 里是模型总结后的文本,需正则提取 URL/标题;
 * - 返回的 URL 是 Google Vertex AI grounding 重定向链接(可点击,非原始 URL);
 * - 每次搜索 = 一次完整 AGY 调用(约 34K input tokens / 5-10 秒)。
 * @module llm-agy/search
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web';
/** AGY 搜索 provider 配置(复用 llm-agy 的 AGY 参数)。 */
export interface AgySearchOptions {
    command: string;
    model: string;
    effort: string;
    proxy?: string;
}
/**
 * 一个 AGY 搜索 provider。
 * search() 通过 spawn `agy -p "搜索 <query>"` 执行,解析 result.response 为 sources。
 */
export declare class AgySearchProvider implements WebSearchProvider {
    private readonly options;
    readonly id = "agy";
    constructor(options: AgySearchOptions);
    /** 本地可用性:命令存在即可;不做联网检查。 */
    available(): boolean;
    /** 执行一次 AGY 搜索。 */
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
    /** 跑一次 AGY print 调用,返回 result.response 原文(latin1 还原),失败返回 undefined。 */
    private runAgy;
}
