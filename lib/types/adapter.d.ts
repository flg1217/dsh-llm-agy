/**
 * AGY 模型适配器:provider 路由 'agy'。
 * 对齐 llm-deepseek/adapter.ts 的结构:LLM 适配器负责 spawn 上游 + 用翻译模块
 * 产出 StreamChunk;工具步骤落地为会话事件(tool/call + tool/result)。
 * @module llm-agy/adapter
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AttachmentsFace } from './read-image.js';
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
    /**
     * 附件服务 getter(由 index.ts 经 captureAttachments 注入):AGY 的
     * view_file 读到图片时,把字节提交成附件引用并以 image 内容块入结果
     * (会话附件授权按内容判定,UI 画廊据此出图;文本模型由 LlmRuntime
     * 投影为占位文本,不受影响)。
     */
    getAttachments?: () => AttachmentsFace | undefined;
    /**
     * 兼容旧配置:无输出兜底时长(ms,默认 10 分钟),作为动态空闲阈值的上限。
     * 动态阈值参数见 {@link AgyAdapterOptions.timeouts}。
     */
    stallTimeoutMs?: number;
    /**
     * 动态空闲超时预算(默认见 {@link DEFAULT_AGY_RUN_TIMEOUTS}):热身行数内
     * 一律 idleMaxMs 宽容,样本足够后阈值 = clamp(历史最大行间隔 × factor,
     * idleMinMs, idleMaxMs)。无总时长上限——有 stdout 行就永远续期。
     */
    timeouts?: {
        firstMs?: number;
        idleMinMs?: number;
        idleMaxMs?: number;
        idleFactor?: number;
        idleWarmupLines?: number;
    };
}
/**
 * AGY 模型适配器。stream() 每次调用:
 * 序列化 prompt → spawn agy -p → 逐行翻译为 StreamChunk(实时) →
 * 工具步骤落地为会话事件 → usage/finish 收尾。
 */
export declare class AgyLlmAdapter extends LlmAdapter {
    private readonly ctx;
    private readonly options;
    /** dsh sessionId → 续接记录(跨轮记忆,续跑只补发 AGY 尚未见过的增量)。 */
    private readonly conversations;
    constructor(ctx: Context, options: AgyAdapterOptions);
    /** 记忆 dsh 会话的续接记录;超限淘汰最旧(Map 迭代序即插入序)。 */
    private rememberConversation;
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
