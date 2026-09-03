/**
 * AGY 一次 print 调用的公共执行器(spawn + stream-json 逐行解析)。
 *
 * 搜索(AgySearchProvider)与读图(agyReadImage)共用:两者都是跑一次完整
 * AGY agent(会自己搜索/看图、阅读全文、综合回答),耗时可能远超 dsh 侧
 * 任何工具的协作式超时预算,因此超时完全由本执行器自主设计:
 *
 * - **空闲超时**:持续输出(step_update)就续命,只有长时间没有任何输出
 *   才判定卡死——深度调研/复杂读图期间 AGY 会不断报告进展,按总时长
 *   一刀切会把正常长任务误杀,因此**不设总时长上限**;进程级兜底由传给
 *   AGY 的 `--print-timeout`(60 分钟)负责,正常任务不会被时长误杀。
 *
 * 错误语义:成功返回 `result.response` 文本;AGY 报错、超时、无输出一律
 * 抛出带原因的 Error,由调用方决定如何呈现。
 * @module llm-agy/agy-run
 */
/** 一次 AGY print 调用的参数。 */
export interface AgyRunTextOptions {
    /** 可 spawn 的可执行文件。 */
    command: string;
    /** 传给 `-p` 的任务提示词。 */
    prompt: string;
    /** 代理地址(可选)。 */
    proxy?: string;
    /** 模型(可选,不传用 AGY 默认)。 */
    model?: string;
    /** 推理强度(可选)。 */
    effort?: string;
    /** 工作目录(可选)。 */
    cwd?: string;
    /** 调用方取消信号。 */
    signal?: AbortSignal;
    /** 空闲超时(可选,默认 3 分钟):多久没有任何输出即判定卡死。 */
    timeouts?: {
        idleMs?: number;
    };
}
/** 默认空闲超时:3 分钟。AGY 每次调用都持续输出 step_update,窗口足够宽松。 */
export declare const DEFAULT_AGY_RUN_TIMEOUTS: {
    idleMs: number;
};
/**
 * 跑一次 AGY print 调用并返回 `result.response` 文本。
 * @throws AGY 显式报错、超时、无输出时抛出带原因的 Error。
 */
export declare function runAgyText(options: AgyRunTextOptions): Promise<string>;
