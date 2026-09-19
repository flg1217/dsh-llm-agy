/**
 * AGY 模型适配器:provider 路由 'agy'。
 *
 * **持久进程架构**(2026-09-18 实测后从"-p 每轮 spawn"切换):
 * 每个 dsh 会话对应一个常驻 `agy --input-format stream-json` 进程,每轮
 * stream() 往 stdin 写一行 NDJSON 用户消息、读事件到本轮 result。
 *
 * 为什么必须这样(全部为实测):
 * - `-p` 一次性模式:长命令约 10s 被 harness 自动转后台,进程只等 5 秒
 *   ("root agent idle; waiting up to 5s for background task(s)")就放弃、
 *   退出并终止后台任务——"已启动,稍后汇报" = 任务悬空丢失;
 * - 持久模式:同一进程里 AGY **自己等待后台任务完成再出 result**
 *   (45s 任务实测:10.8s 启动 → 自动等 → 58.2s 确认结果 → 60.1s result),
 *   任务注册表跨轮存活(下一轮 manage_task 可查 DONE)——后台任务支持成立,
 *   且不依赖任何提示词纪律;
 * - 附带收益:prompt 走 stdin,不再受命令行长度限制(旧 32K 阈值放宽到
 *   stdin 实测截断上限 ~2.5MB);不再每轮冷启动 ~6s。
 *
 * 工具步骤仍落地为会话事件(tool/call + tool/result),失败归因/执行反馈/
 * 续接记录(ConversationStore)与旧实现同语义。
 * @module llm-agy/adapter
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { ConversationStore } from './conversations.js';
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
    /**
     * 续接记录的存储(默认落盘 `~/.dsh/agy/conversations.json`;测试注入
     * 纯内存实例)。跨重启保留 conversationId 与发送锚点——否则重启后首个
     * 续跑会退化成全量重发(实测历史可达 1.2MB)。
     */
    store?: ConversationStore;
    /**
     * AGY 工具全 dsh 化开关(getter,默认 true):每次启动进程时现读——
     * true 时部署 dsh-executor 自定义 agent(禁内置工具)+ 把 dsh MCP 端点
     * 写入 agy 全局配置,并以 `--agent dsh-executor` 启动。
     */
    dshExecutor?: () => boolean;
}
/**
 * AGY 模型适配器。每个 dsh 会话一个常驻进程(--input-format stream-json),
 * stream() 每调用 = 该进程的一轮 stdin/stdout 交互。
 */
export declare class AgyLlmAdapter extends LlmAdapter {
    private readonly ctx;
    private readonly options;
    /** dsh sessionId → 常驻进程。 */
    private readonly sessions;
    /** dsh sessionId → 续接记录(持久化,续跑只补发 AGY 尚未见过的增量)。 */
    private readonly conversations;
    constructor(ctx: Context, options: AgyAdapterOptions);
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /** 取会话的常驻进程;不存在/已退出则按续接记录启动(带 --conversation)。 */
    private acquire;
    /** 启动常驻 agy 进程并装好行/退出/错误处理。 */
    private startSession;
    /** 杀会话进程(abort/会话失效/回收),含残留工具子进程。 */
    private killSession;
    /** 轮结束后的空闲回收:时长足够后台任务跑完;到时无新轮则关进程释放资源。 */
    private armIdleRecycle;
    /** 进程级行处理:翻译 + 工具事件落地 + 轮结算(全部按当前 active 归属)。 */
    private onLine;
    /** 工具步骤落地为会话事件(语义与旧 -p 实现一致,状态挂在轮上)。 */
    private handleToolStep;
    /** DONE/ERROR 的异步补全与落地(view_file 图片走附件通道;write/edit 附 diff)。 */
    private enrichToolResult;
    /** 建立一轮:translator、工具事件上下文与动态空闲计时。 */
    private beginTurn;
    /** 收束一轮:清计时器、解除 active、安排空闲回收。 */
    private endTurn;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
}
