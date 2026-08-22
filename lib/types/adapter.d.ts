/**
 * AGY 模型适配器:provider 路由 'agy'。
 * 对齐 llm-deepseek/adapter.ts 的结构:LLM 适配器负责 spawn 上游 + 用翻译模块
 * 产出 StreamChunk;工具步骤落地为会话事件(tool/call + tool/result)。
 * @module llm-agy/adapter
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
/** 适配器配置(由 index.ts 传入)。 */
export interface AgyAdapterOptions {
    command: string;
    model: string;
    effort: string;
    extraArgs: string[];
    /** AGY 资格检查/API 流量代理;空字符串禁用。 */
    proxy?: string;
    /** 启动级失败重试次数。 */
    maxAttempts?: number;
    /** 启动级失败重试间隔(毫秒)。 */
    retryDelayMs?: number;
    /** 无输出兜底:AGY 超过该时长无任何 stdout 输出则强制结束(默认 10 分钟)。 */
    stallTimeoutMs?: number;
}
/**
 * AGY 模型适配器。stream() 每次调用:
 * 序列化 prompt → spawn agy -p → 逐行翻译为 StreamChunk(实时) →
 * 工具步骤落地为会话事件 → usage/finish 收尾。
 */
export declare class AgyLlmAdapter extends LlmAdapter {
    private readonly ctx;
    private readonly options;
    constructor(ctx: Context, options: AgyAdapterOptions);
    /**
     * 绑定模型元数据与分发流入口(rc.2+ 的 LlmAdapter 接口)。
     * 显式实现而非依赖基类:插件对宿主 dsh-llm 版本保持兼容
     * (rc.6 宿主不调用此方法;rc.2+ 宿主调用本实现)。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
}
