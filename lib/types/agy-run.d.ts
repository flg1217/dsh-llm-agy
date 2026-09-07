/**
 * AGY 一次 print 调用的公共执行器(spawn + stream-json 逐行解析)。
 *
 * 搜索(AgySearchProvider)与读图(agyReadImage)共用:两者都是跑一次完整
 * AGY agent(会自己搜索/看图、阅读全文、综合回答),耗时可能远超 dsh 侧
 * 任何工具的协作式超时预算,因此超时完全由本执行器自主设计:
 *
 * 超时完全动态,不写死总时长:
 *
 * - **首包超时**(`firstMs`):spawn 到第一行输出。正常情况下 AGY 约 8s 出首包;
 *   卡在启动/登录/代理握手时一行都没有,必须早失败而不是干等。
 * - **动态空闲超时**:每行输出都重置静默计时(动态续期);静默阈值不是写死的,
 *   而是按本次调用**已观测到的最大行间隔**自适应:
 *   `阈值 = clamp(最大间隔 × idleFactor, idleMinMs, idleMaxMs)`。
 *   轻任务(行间隔 1~2s)卡死约 idleMinMs 就快速失败;深度任务(思考/逐格审查
 *   期间 stdout 静默可达 1~3 分钟)的间隔被观测后阈值自动放宽到 idleMaxMs。
 *   首行之前无样本,直接用 idleMaxMs 宽容等待——宁可慢失败,不可误杀。
 * - **无总时长上限**:只要有输出就永远续期。病理循环由 AGY 自身的
 *   `--print-timeout`(60 分钟)兜底。
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
     * 超时预算(全部可选,默认见 {@link DEFAULT_AGY_RUN_TIMEOUTS}):
     * - `firstMs`: 首包超时;
     * - `idleMinMs` / `idleMaxMs`: 动态空闲阈值的下限/上限;
     * - `idleFactor`: 阈值 = clamp(历史最大行间隔 × factor, min, max);
     * - `idleWarmupLines`: 行数未到此样本数之前一律用 idleMaxMs 宽容
     *   (任务早期的历史间隔还不足以预测后续的深度思考静默)。
     */
    timeouts?: {
        firstMs?: number;
        idleMinMs?: number;
        idleMaxMs?: number;
        idleFactor?: number;
        idleWarmupLines?: number;
    };
}
/** 默认超时预算:空闲阈值随历史输出间隔自适应,无总时长上限(有输出即续期)。
 * AGY(尤其 gemini-3.8-high 这类 thinking 模型)在深度思考/内部执行期间
 * stdout 可以静默 1~3 分钟以上,固定阈值必然误杀——故按本次调用已观测的
 * 最大行间隔自适应:热身行数内用 idleMaxMs 宽容(早期的历史间隔还预测不了
 * 后续的长静默),样本足够后阈值收紧到 clamp(最大间隔 × factor, min, max)。
 * 真卡死由 idleMaxMs 死线与 AGY 自身 --print-timeout(60 分钟)兜底。 */
export declare const DEFAULT_AGY_RUN_TIMEOUTS: {
    firstMs: number;
    idleMinMs: number;
    idleMaxMs: number;
    idleFactor: number;
    idleWarmupLines: number;
};
/**
 * 跑一次 AGY print 调用并返回 `result.response` 文本。
 * @throws AGY 显式报错、超时、无输出时抛出带原因的 Error。
 */
export declare function runAgyText(options: AgyRunTextOptions): Promise<string>;
