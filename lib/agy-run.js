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
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
/** 默认空闲超时:3 分钟。AGY 每次调用都持续输出 step_update,窗口足够宽松。 */
export const DEFAULT_AGY_RUN_TIMEOUTS = { idleMs: 180_000 };
/**
 * 跑一次 AGY print 调用并返回 `result.response` 文本。
 * @throws AGY 显式报错、超时、无输出时抛出带原因的 Error。
 */
export async function runAgyText(options) {
    const command = options.command;
    const proxy = options.proxy;
    const proc = spawn(command, [
        '-p', options.prompt,
        '--output-format', 'stream-json',
        // AGY 默认 print-timeout 5 分钟,长任务会超时退出 1;放宽到 1 小时
        // (真正的卡死检测由下面的空闲超时负责)。
        '--print-timeout', '60m',
        ...(options.model !== undefined && options.model.length > 0 ? ['--model', options.model] : []),
        ...(options.effort !== undefined && options.effort.length > 0 ? ['--effort', options.effort] : []),
        '--dangerously-skip-permissions',
    ], {
        ...options.cwd !== undefined ? { cwd: options.cwd } : {},
        stdio: ['ignore', 'pipe', 'inherit'],
        windowsHide: true,
        env: proxy
            ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy }
            : { ...process.env },
    });
    const idleMs = options.timeouts?.idleMs ?? DEFAULT_AGY_RUN_TIMEOUTS.idleMs;
    let timedOut = false;
    let resultError;
    // 空闲超时:长时间无任何输出才判卡死(还在出活就续命)。
    let idleKiller;
    const armIdle = () => {
        if (idleKiller !== undefined)
            clearTimeout(idleKiller);
        idleKiller = setTimeout(() => {
            timedOut = true;
            resultError = `AGY 调用超时(空闲 ${Math.round(idleMs / 1000)}s 无输出)`;
            proc.kill();
        }, idleMs);
    };
    armIdle();
    let response;
    try {
        if (proc.stdout === null)
            throw new Error('AGY 进程没有 stdout');
        proc.stdout.setEncoding('latin1');
        const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
        for await (const line of rl) {
            if (options.signal?.aborted) {
                proc.kill();
                break;
            }
            if (timedOut)
                break;
            // 还在出活就续命。
            armIdle();
            if (!line.trim().startsWith('{'))
                continue;
            try {
                const evt = JSON.parse(line);
                if (evt.event === 'result') {
                    const r = evt.result;
                    if (r?.status === 'SUCCESS' && typeof r.response === 'string' && r.response.length > 0) {
                        response = Buffer.from(r.response, 'latin1').toString('utf8');
                    }
                    else if (r?.status === 'ERROR' && typeof r.error === 'string') {
                        resultError = Buffer.from(r.error, 'latin1').toString('utf8').slice(0, 300);
                    }
                }
            }
            catch { /* 非 JSON 行跳过 */ }
        }
    }
    finally {
        clearTimeout(idleKiller);
        try {
            proc.kill();
        }
        catch { /* 已退出 */ }
    }
    if (resultError !== undefined)
        throw new Error(`AGY 调用失败:${resultError}`);
    if (response === undefined) {
        throw new Error(options.signal?.aborted ? 'AGY 调用已取消' : 'AGY 调用无输出');
    }
    return response;
}
