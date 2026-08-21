/**
 * AGY 模型适配器:provider 路由 'agy'。
 * 对齐 llm-deepseek/adapter.ts 的结构:LLM 适配器负责 spawn 上游 + 用翻译模块
 * 产出 StreamChunk;工具步骤落地为会话事件(tool/call + tool/result)。
 * @module llm-agy/adapter
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { LlmAdapter, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { buildPrompt } from './serialize.js';
import { AgyTranslator, agyCallId } from './translate.js';
/** 可重试的 AGY 执行错误(网络/服务端偶发问题),匹配则恢复会话重试。 */
const RETRYABLE_ERROR_RE = /retryable|network issue|connection|timeout|overloaded|unavailable|5\d\d|ECONN|ETIMEDOUT/i;
/** AGY 进程退出兜底:进程卡死(如上下文超限后挂起)时强制结束,
 * 保证 stream 一定会结束 → 子代理 agent 一定 idle → settle 通知必达。 */
async function closeWithTimeout(proc, signal, timeoutMs = 30_000) {
    const closePromise = once(proc, 'close');
    let timer;
    if (signal?.aborted) {
        proc.kill();
    }
    else {
        timer = setTimeout(() => {
            // 兜底:AGY 卡死(不退出、不输出)时杀掉,让调用方以错误收尾。
            proc.kill();
        }, timeoutMs);
    }
    try {
        return await closePromise;
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/**
 * AGY 模型适配器。stream() 每次调用:
 * 序列化 prompt → spawn agy -p → 逐行翻译为 StreamChunk(实时) →
 * 工具步骤落地为会话事件 → usage/finish 收尾。
 */
export class AgyLlmAdapter extends LlmAdapter {
    ctx;
    options;
    constructor(ctx, options) {
        super();
        this.ctx = ctx;
        this.options = options;
    }
    async *stream(options) {
        const command = this.options.command;
        // 请求级 model 优先(子代理可经 agentOptions.model 动态指定),回退到配置值。
        const model = options.model ?? this.options.model;
        const effort = this.options.effort;
        const maxAttempts = this.options.maxAttempts ?? 5;
        const retryDelayMs = this.options.retryDelayMs ?? 15_000;
        const { prompt, cleanup } = await buildPrompt(this.ctx, options);
        // AGY 是完整 harness CLI,自己在内部执行工具(浏览器/命令等);
        // 其工作目录对齐子代理会话的工作区,保证文件操作/截图发生在正确目录。
        const childSession = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined;
        const cwd = childSession?.header.cwd ?? process.cwd();
        try {
            // 首次 AGY 会话 id:第 2 次尝试起用 --conversation 恢复续跑。
            let conversationId;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (options.signal?.aborted)
                    throw options.signal.reason ?? new Error('aborted');
                // 第 2 次起:复用首次 AGY 会话续跑,而不是重头执行;
                // 中途偶发网络错误重试时不会重复已完成的工具操作与文本。
                // 续跑 prompt 不能是原任务(会被当作新消息重做一遍),而是明确指示
                // 继续未完成的工作、不要重复已完成部分。
                const attemptPrompt = attempt > 1 && conversationId !== undefined
                    ? '继续完成之前未完成的任务。基于当前工作区状态继续,不要重复已完成的工作,只报告新做的内容。'
                    : prompt;
                const resumeArgs = attempt > 1 && conversationId !== undefined
                    ? ['--conversation', conversationId]
                    : [];
                const proc = spawn(command, [
                    '-p', attemptPrompt,
                    '--output-format', 'stream-json',
                    // AGY 默认 print-timeout 5 分钟,长任务会超时退出 1;放宽到 1 小时。
                    '--print-timeout', '60m',
                    '--model', model,
                    '--effort', effort,
                    // 非交互模式下 AGY 的工具调用需要放行。
                    '--dangerously-skip-permissions',
                    // 显式指定工作区:否则 AGY 默认在用户主目录搜索/操作。
                    '--add-dir', cwd,
                    ...resumeArgs,
                    ...this.options.extraArgs,
                ], {
                    cwd,
                    stdio: ['ignore', 'pipe', 'inherit'],
                    windowsHide: true,
                    // AGY 资格检查(googleapis)走代理。
                    env: {
                        ...process.env,
                        ...this.options.proxy
                            ? { HTTPS_PROXY: this.options.proxy, HTTP_PROXY: this.options.proxy, ALL_PROXY: this.options.proxy }
                            : {},
                    },
                });
                if (proc.stdout === null) {
                    proc.kill();
                    throw new Error('llm-agy: agy process has no stdout stream');
                }
                const onAbort = () => { proc.kill(); };
                options.signal?.addEventListener('abort', onAbort, { once: true });
                // 无输出兜底:AGY 卡死(不输出、不退出,如上下文超限后挂起)时强制结束,
                // 保证 stream 一定结束 → 子代理 agent 一定 idle → settle 通知必达。
                // 必须在 readline 循环之前启动——若 AGY 启动后就不输出,readline 永不结束,
                // 放在循环之后等待的兜底永远不会执行。收到任何 stdout 数据即重置计时,
                // 正常长任务(持续输出)不会误杀。
                const idleMs = this.options.stallTimeoutMs ?? 10 * 60_000;
                let idleKiller;
                const armIdleKiller = () => {
                    clearTimeout(idleKiller);
                    idleKiller = setTimeout(() => { proc.kill(); }, idleMs);
                };
                armIdleKiller();
                proc.stdout.on('data', armIdleKiller);
                // 工具步骤落地为会话事件所需的 turn/step(从子代理会话推断)。
                const session = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined;
                const events = session?.events ?? [];
                const turn = ([...events].reverse().find(e => e.type === 'turn/start')?.data.turn ?? 1);
                const step = ([...events].reverse().find(e => e.type === 'step/start')?.data.step ?? 1);
                const toolCallSeq = new Map(); // step_index → tool/call seq
                const translator = new AgyTranslator();
                let hasOutput = false;
                let sawToolStep = false;
                try {
                    // 字节级读取 + 流式解码:AGY 的 text_delta 按字节切分,
                    // latin1 保留原始字节,TextDecoder 流式跨事件恢复完整字符。
                    proc.stdout.setEncoding('latin1');
                    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
                    for await (const line of rl) {
                        if (options.signal?.aborted) {
                            proc.kill();
                            break;
                        }
                        const { chunks, step: agyStep, conversationId: cid } = translator.push(line);
                        if (cid !== undefined)
                            conversationId = cid;
                        for (const chunk of chunks) {
                            hasOutput = true;
                            yield chunk;
                        }
                        if (agyStep !== undefined && session !== undefined) {
                            const { stepType, state, toolName, toolParams, stepIndex } = agyStep;
                            if (stepType === 'tool' && toolName !== undefined) {
                                sawToolStep = true;
                                const callId = agyCallId(toolName, stepIndex, attempt);
                                if (state === 'ACTIVE') {
                                    const ev = session.append('tool/call', {
                                        turn,
                                        step,
                                        callId,
                                        name: toolName,
                                        arguments: JSON.stringify(toolParams ?? {}),
                                    });
                                    if (stepIndex !== undefined)
                                        toolCallSeq.set(stepIndex, ev.seq);
                                    // 记录最近执行步骤(完整参数):反馈时主代理能看到异常发生在哪一步。
                                    const args = JSON.stringify(toolParams ?? {});
                                    translator.recentSteps.push({ toolName, args, status: 'running' });
                                    if (translator.recentSteps.length > 8)
                                        translator.recentSteps.splice(0, translator.recentSteps.length - 8);
                                }
                                else if (state === 'DONE' || state === 'ERROR') {
                                    const seq = stepIndex !== undefined ? toolCallSeq.get(stepIndex) : undefined;
                                    const output = agyStep.output;
                                    // 工具输出同样做 latin1→UTF-8 还原(与 text_delta 一致;
                                    // AGY 输出的 JSON 字符串经 latin1 读取后,高位字节需还原)。
                                    const raw = typeof output === 'string' ? output : '';
                                    const textOut = raw.length > 0 ? Buffer.from(raw, 'latin1').toString('utf8') : '';
                                    session.append('tool/result', {
                                        turn,
                                        step,
                                        message: createToolResultMessage({
                                            callId,
                                            content: [{ type: 'text', text: textOut.slice(0, 2000) }],
                                            isError: state === 'ERROR',
                                        }),
                                    }, {
                                        surfaceOp: 'append',
                                        ...(seq !== undefined ? { sourceEventSeqs: [seq] } : {}),
                                    });
                                    // 更新最近步骤的结果状态。
                                    const last = translator.recentSteps.at(-1);
                                    if (last !== undefined && last.toolName === toolName && last.status === 'running') {
                                        last.status = state === 'ERROR' ? 'FAILED' : 'OK';
                                        if (state === 'ERROR') {
                                            last.message = textOut.split('\n')[0]?.slice(0, 200) ?? 'unknown error';
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // 冲刷解码器残余字节(最后一段文本的尾字符可能被截断)。
                    for (const chunk of translator.flush()) {
                        hasOutput = true;
                        yield chunk;
                    }
                }
                finally {
                    clearTimeout(idleKiller);
                    proc.stdout.removeListener('data', armIdleKiller);
                    options.signal?.removeEventListener('abort', onAbort);
                }
                const [code] = await closeWithTimeout(proc, options.signal);
                const resultError = translator.resultError;
                // AGY 偶发"冷启动即静默退出 0、零输出"(认证/代理预检抖动,stderr 也无报错)。
                // 若被 code===0 判为成功,子代理会空跑完成、工具返回 "(no output)"。
                // 零输出且零工具步骤不是合法的空回答,合成 retryable 错误走既有重试。
                const silentEmptyExit = resultError === undefined && !hasOutput && !sawToolStep && code === 0
                    ? 'retryable: agy exited with code 0 but produced no output (transient startup failure)'
                    : undefined;
                const effectiveError = resultError ?? silentEmptyExit;
                const retryable = effectiveError !== undefined && RETRYABLE_ERROR_RE.test(effectiveError);
                // 上下文超限:只在 AGY 错误消息明确提到 context/limit/exceed 时才判定。
                // 不能用 usage 累加判断——AGY 会自动裁剪上下文,input_tokens 是增量累加,
                // 累加值(总消耗)不代表单次请求大小,会误报。
                const contextExhausted = resultError !== undefined && /context|token limit|window|exceed|maximum length|too large/i.test(resultError);
                // 执行反馈:无论什么失败(工具错、收尾网络错、上下文超限)都反馈给外层。
                // 任何异常都附上最近的完整执行轨迹,主代理能看到异常发生在哪个环节。
                const executionFeedbackBlocks = () => {
                    const steps = translator.recentSteps;
                    const failed = steps.filter(s => s.status === 'FAILED');
                    // 没有任何失败迹象(无 effectiveError / 无工具错 / 上下文没超限)→ 不输出
                    if (effectiveError === undefined && failed.length === 0 && !contextExhausted)
                        return [];
                    const lines = [];
                    if (effectiveError !== undefined) {
                        lines.push(`**执行报错**:${effectiveError.slice(0, 250)}`);
                    }
                    if (contextExhausted) {
                        lines.push(`**AGY 报告上下文超限**,继续重试大概率无意义`);
                    }
                    if (failed.length > 0) {
                        lines.push(`**${failed.length} 步工具调用失败**`);
                    }
                    // 异常发生的位置:总是附上最近的执行轨迹。
                    if (steps.length > 0) {
                        lines.push(`**最近执行步骤**(异常发生在这里,前 8 步):`);
                        lines.push(...steps.map(s => {
                            const mark = s.status === 'FAILED' ? '✗ FAILED' : s.status === 'OK' ? '✓ OK' : '… running';
                            return `  - ${s.toolName} ${s.args} → ${mark}${s.message !== undefined ? ` | ${s.message}` : ''}`;
                        }));
                    }
                    const idx = translator.nextIndex + 1;
                    const text = `[AGY 子代理执行异常反馈]\n${lines.join('\n')}`;
                    return [
                        { type: 'block-start', index: idx, blockType: 'text' },
                        { type: 'text-delta', index: idx, text },
                        { type: 'block-end', index: idx, block: { type: 'text', text } },
                    ];
                };
                // 成功:无执行错误且(正常退出或已有输出)。静默零输出被有效错误覆盖,不在此列。
                if (effectiveError === undefined && (code === 0 || hasOutput)) {
                    for (const chunk of translator.end())
                        yield chunk;
                    for (const chunk of executionFeedbackBlocks())
                        yield chunk;
                    return;
                }
                // retryable 网络/服务端错误(AGY result ERROR 或 code!=0):恢复同一会话续跑,
                // 不重头执行(工具副作用与已输出文本都不会重复)。
                if (retryable && !contextExhausted && attempt < maxAttempts) {
                    await new Promise(resolve => {
                        const t = setTimeout(resolve, retryDelayMs);
                        options.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
                    });
                    continue;
                }
                // 非 retryable 或重试用尽:产出 finish 错误。
                for (const chunk of translator.end())
                    yield chunk;
                for (const chunk of executionFeedbackBlocks())
                    yield chunk;
                return;
            }
        }
        finally {
            await cleanup();
        }
    }
    resolveModel(provider, model) {
        return Promise.resolve({
            provider,
            id: model,
            name: model,
            // AGY 由 Gemini 驱动,支持文本与图像输入(视觉看图子代理依赖此项)。
            inputModalities: ['text', 'image'],
            context: { contextWindow: 1_000_000 },
        });
    }
}
