/**
 * 翻译模块:把 AGY stream-json 事件翻译为 harness StreamChunk 流。
 * 对齐 llm-deepseek/translate.ts 的模式:
 * - 文本块在首个 delta 时打开,后续 delta 持续追加,block-end 延迟到流结束;
 * - usage 按 dsh 的 disjoint 约定(cache 从 input 扣除,reasoning 单独计数);
 * - finish 最后产出;AGY 偶发执行失败携带错误,由调用方决定重试。
 * @module llm-agy/translate
 */
import { CallId } from '@deepseek-ai/dsh-llm';
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { AgyLine, AgyStep, AgyUsage } from './types.js';
/** AGY usage → dsh TokenUsage。
 * AGY 的 input_tokens/output_tokens/thinking_tokens 是分步增量(累计后等于
 * result 全量),且 input_tokens 本身不含缓存;cache_read_tokens 是累计值。
 * 因此直接映射即为 disjoint 约定,不要再从 inputTokens 扣减 cache
 * (否则 input < cache 时产生负数,持久化 schema 校验会失败)。
 */
export declare function mapAgyUsage(u: AgyUsage): TokenUsage;
/** 解析 AGY stream-json 一行。 */
export declare function parseAgyLine(line: string): AgyLine | undefined;
/**
 * AGY → StreamChunk 翻译状态机。
 * 调用方逐行 push,收集返回的 chunks 与工具步骤;流结束后调用 end() 收尾。
 */
export declare class AgyTranslator {
    private nextIndexValue;
    private textOpen;
    private _text;
    private _usage;
    private _resultError;
    /** 单次请求的 input_tokens(最后一次 usage 步),用于判断单次请求是否超限。 */
    private _lastInputTokens;
    /** result.response 的完整最终文本(无 U+FFFD 截断损坏),end() 时覆盖流式拼接。 */
    private _finalText;
    /** 已收到 result 终局事件。 */
    private _final;
    /** 最近执行步骤(工具名+参数摘要+结果),供反馈块呈现异常发生的位置。 */
    readonly recentSteps: {
        toolName: string;
        args: string;
        status: string;
        message?: string;
    }[];
    private readonly utf8;
    /**
     * 处理一行 AGY 输出。
     * @returns 本行产生的 StreamChunk(文本流,实时)与工具步骤(由调用方落地为会话事件)。
     */
    push(line: string): {
        chunks: StreamChunk[];
        step?: AgyStep;
        conversationId?: string;
        final?: boolean;
    };
    /** 冲刷解码器残余字节(AGY 最后一段文本的尾字符可能被截断)。 */
    flush(): StreamChunk[];
    /** 流结束:关闭文本块、产出 usage 与 finish。 */
    end(): StreamChunk[];
    /** 已收到的执行错误(AGY result ERROR)。 */
    get resultError(): string | undefined;
    /** 下一个可用 block index(adapter 附加反馈块时使用)。 */
    get nextIndex(): number;
    /** 累计输入 token(含缓存)。AGY 的 input_tokens 是增量,cacheRead 是累计值。 */
    get totalInputTokens(): number;
    /**
     * 单次请求的 input_tokens(最近一次有 usage 的步)。
     * 累计的 totalInputTokens 不代表单次请求大小,不能用它判断"上下文爆了"。
     */
    get lastInputTokens(): number;
}
/** 生成工具卡片用的 callId。
 * 同一 step_index 的 ACTIVE/DONE 配对;attempt 区分重试执行——重试恢复
 * AGY 会话后 step_index 会重复出现,不加 attempt 会产生重复 callId,
 * 导致会话轨迹构建报 "more than one start Match"。
 */
export declare function agyCallId(toolName: string, stepIndex: number | undefined, attempt?: number): CallId;
