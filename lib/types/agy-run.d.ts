/**
 * AGY 一次 print 调用的公共执行器(spawn + stream-json 逐行解析)。
 *
 * 搜索(AgySearchProvider)与读图(agyReadImage)共用:两者都是跑一次完整
 * AGY agent(会自己搜索/看图、阅读全文、综合回答),耗时可能远超 dsh 侧
 * 任何工具的协作式超时预算,因此超时完全由本执行器自主设计:
 *
 * 超时分三段,各自解决一类事故:
 *
 * - **首包超时**(`firstMs`):spawn 到第一行输出。正常情况下 AGY 约 8s 出首包;
 *   卡在启动/登录/代理握手时一行都没有,必须早失败而不是干等。
 * - **空闲超时**(`idleMs`):持续输出(step_update)就续命,长时间没有任何
 *   输出才判定卡死。深度调研期间 AGY 会不断报告进展,所以空闲窗口按
 *   "正常出活间隔"定,不是按总时长。
 * - **总时长软上限**(`totalMs`):防止"一直有输出但永远不收敛"的调用
 *   无限占用。默认 10 分钟,读图这类短任务调用方会传更短的值。
 *
 * 关键约束:**超时必须真的能返回**。只 `proc.kill()` 不够——若是包装脚本
 * 起的进程树,子进程可能仍持有 stdout 写端,`for await (const line of rl)`
 * 会永久挂起(此时唯一的定时器已经 fire 过,再没有任何东西能救)。因此超时
 * 回调里要同时 `rl.close()` + `stdout.destroy()`,并用 `finish()` 直接放行
 * 等待。
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
    /**
     * 超时预算(全部可选):
     * - `firstMs`: 首包超时,默认 45s(正常约 8s);
     * - `idleMs`: 空闲超时,默认 60s(持续输出就续命);
     * - `totalMs`: 总时长软上限,默认 10 分钟。
     */
    timeouts?: {
        firstMs?: number;
        idleMs?: number;
        totalMs?: number;
    };
}
/** 默认超时预算。 */
export declare const DEFAULT_AGY_RUN_TIMEOUTS: {
    firstMs: number;
    idleMs: number;
    totalMs: number;
};
/**
 * 跑一次 AGY print 调用并返回 `result.response` 文本。
 * @throws AGY 显式报错、超时、无输出时抛出带原因的 Error。
 */
export declare function runAgyText(options: AgyRunTextOptions): Promise<string>;
