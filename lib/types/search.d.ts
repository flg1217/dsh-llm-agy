/**
 * AGY 搜索 provider:`search_web_agy` 工具的执行后端。
 *
 * - available() 只做本地可用性检查(不联网);
 * - search() 经公共执行器跑一次 AGY 深度调研,解析 result.response 提取 sources。
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
    /**
     * 超时预算(可选)。生产用执行器默认(空闲 3 分钟 / 总 15 分钟);
     * 测试注入小值以便压缩时间。
     */
    timeouts?: {
        idleMs?: number;
        totalMs?: number;
    };
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
}
