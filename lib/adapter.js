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
import { execFile, spawn } from 'node:child_process';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { LlmAdapter, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { buildPrompt, continuationPrompt, resumeReplayPrompt } from './serialize.js';
import { ConversationStore } from './conversations.js';
import { AgyTranslator, agyCallId } from './translate.js';
import { DEFAULT_AGY_RUN_TIMEOUTS } from './agy-run.js';
import { AGY_FILE_MUTATION_TOOLS, agyToolFilePath, enrichAgyToolResult, readFileRaw, readImageFile } from './tool-preview.js';
import { commitImagePresentation } from './read-image.js';
/**
 * 可重试的 AGY 执行错误(网络/服务端/登录态问题),匹配则恢复会话重试。
 * 认证类(not logged in / login / credential / token / unauthorized / expired)必须重试:
 * AGY 首调时会自动完成登录态刷新/认证(冷启动语言服务器 + token 加载),
 * 首次请求因此失败时,后续重试通常即可成功。
 */
const RETRYABLE_ERROR_RE = /retryable|network issue|connection|timeout|overloaded|unavailable|5\d\d|ECONN|ETIMEDOUT|not logged|login|credential|token source|unauthorized|expired/i;
/**
 * AGY 会话失效(被清理/过期/不存在)的错误特征。命中时不重试:
 * --conversation 恢复的对话找不回来,重试只会重复失败;也**不回退全量重发**
 * (token 开销巨大,且历史会被 AGY 当作新任务从头重跑,实测)——直接报错,
 * 由调用方决定重新开任务还是放弃。
 */
const CONVERSATION_LOST_RE = /(no such|not found|unknown|invalid|expired|does not exist|missing)[^\n]{0,60}conversation|conversation[^\n]{0,60}(not found|does not exist|expired|invalid|unknown|missing)/i;
/** 常驻进程空闲回收时长(无活跃轮后多久关掉;后台任务也可能在此期间跑完)。 */
const SESSION_IDLE_RECYCLE_MS = 15 * 60 * 1000;
/** result 后仍有 RUNNING 任务时,dsh 主动续轮等待的上限(防死循环)。 */
const MAX_TASK_WAIT_ROUNDS = 10;
/** 仍视为"在运行"的任务状态(manage_task 输出的大写状态词)。 */
const TASK_RUNNING_RE = /^(RUNNING|PENDING|IN_PROGRESS|QUEUED|STARTING)$/i;
/**
 * 从工具输出提取后台任务状态(manage_task / command_status 的稳定文本格式,
 * 实测:"Task: <conversationId>/task-N\nStatus: RUNNING\nLog: ...\nLast progress: ...")。
 * 这是"识别对话状态"的协议层途径:dsh 不依赖模型自觉,自己跟踪任务终态。
 */
function collectTaskStates(states, text) {
    const re = /Task:\s*(\S+)[^\n]*\nStatus:\s*([A-Za-z_]+)/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        const id = match[1];
        const status = match[2];
        if (id !== undefined && status !== undefined)
            states.set(id, status.toUpperCase());
    }
}
/** 当前仍未见终态的任务 id(用于 dsh 侧自动续轮等待)。 */
function runningTaskIds(tasks) {
    return [...tasks.entries()]
        .filter(([, status]) => TASK_RUNNING_RE.test(status))
        .map(([id]) => id);
}
/** 进程树杀:AGY 残留的 npm/工具子进程会占端口、拖住输出流,必须 /T 递归。 */
function killProcessTree(proc) {
    try {
        if (proc.pid !== undefined) {
            spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
                .on('error', () => { try {
                proc.kill();
            }
            catch { /* 已退出 */ } });
        }
    }
    catch { /* 已退出 */ }
    try {
        proc.kill();
    }
    catch { /* 已退出 */ }
    try {
        proc.stdout?.destroy();
    }
    catch { /* 已关闭 */ }
}
/**
 * AGY 模型适配器。每个 dsh 会话一个常驻进程(--input-format stream-json),
 * stream() 每调用 = 该进程的一轮 stdin/stdout 交互。
 */
export class AgyLlmAdapter extends LlmAdapter {
    ctx;
    options;
    /** dsh sessionId → 常驻进程。 */
    sessions = new Map();
    /** dsh sessionId → 续接记录(持久化,续跑只补发 AGY 尚未见过的增量)。 */
    conversations;
    constructor(ctx, options) {
        super();
        this.ctx = ctx;
        this.options = options;
        this.conversations = options.store ?? new ConversationStore();
    }
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
    }
    // ────────────────────────── 进程管理 ──────────────────────────
    /** 取会话的常驻进程;不存在/已退出则按续接记录启动(带 --conversation)。 */
    acquire(sessionId, cwd, priorConversationId) {
        let session = this.sessions.get(sessionId);
        if (session !== undefined && !session.exited) {
            if (session.idleTimer !== undefined) {
                clearTimeout(session.idleTimer);
                session.idleTimer = undefined;
            }
            session.lastUsedAt = Date.now();
            return session;
        }
        session = this.startSession(sessionId, cwd, priorConversationId);
        this.sessions.set(sessionId, session);
        return session;
    }
    /** 启动常驻 agy 进程并装好行/退出/错误处理。 */
    startSession(sessionId, cwd, priorConversationId) {
        const model = this.options.model;
        // 模型名自带强度后缀(gemini-3.8-flash-high 等)时,AGY 拒绝再传
        // --effort("--model X conflicts with --effort=Y"),此时静默省略。
        const effortArgs = /-(low|medium|high)$/i.test(model) ? [] : ['--effort', this.options.effort];
        const proc = spawn(this.options.command, [
            // 官方 driver 模式:stdin 逐行 NDJSON,一个进程跑多轮;后台任务在
            // 同进程内被管理(回合结束不退出、任务完成唤醒 agent,实测)。
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            // AGY 默认 print-timeout 5 分钟,长任务会超时;放宽到 1 小时。
            '--print-timeout', '60m',
            '--model', model,
            ...effortArgs,
            // 非交互模式下 AGY 的工具调用需要放行。
            '--dangerously-skip-permissions',
            // 显式指定工作区:否则 AGY 默认在用户主目录搜索/操作。
            '--add-dir', cwd,
            ...priorConversationId !== undefined ? ['--conversation', priorConversationId] : [],
            ...this.options.extraArgs,
        ], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            // AGY 资格检查(googleapis)走代理。
            env: {
                ...process.env,
                ...this.options.proxy
                    ? { HTTPS_PROXY: this.options.proxy, HTTP_PROXY: this.options.proxy, ALL_PROXY: this.options.proxy }
                    : {},
            },
        });
        const session = {
            sessionId,
            proc,
            cwd,
            exited: false,
            stderrTail: '',
            lastUsedAt: Date.now(),
        };
        if (proc.stdout == null || proc.stdin == null) {
            session.spawnError = 'llm-agy: agy process has no stdout/stdin stream';
            session.exited = true;
            try {
                proc.kill();
            }
            catch { /* 已退出 */ }
            return session;
        }
        // 字节级读取 + 流式解码:AGY 的 text_delta 按字节切分,
        // latin1 保留原始字节,TextDecoder 流式跨事件恢复完整字符。
        proc.stdout.setEncoding('latin1');
        const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
        session.closeLines = () => { rl.close(); };
        rl.on('line', (line) => { this.onLine(session, line); });
        // stderr:归因证据 + "等后台任务"硬信号(明确续期,stall 不误杀)。
        if (proc.stderr !== null) {
            proc.stderr.setEncoding('utf8');
            proc.stderr.on('data', (chunk) => {
                session.stderrTail = (session.stderrTail + chunk).slice(-4000);
                // 例:"root agent idle; waiting up to 5s for 1 background task(s)"
                if (/agent idle|waiting .*background task/i.test(chunk)) {
                    session.active?.touch();
                }
            });
        }
        proc.on('error', (error) => {
            session.spawnError = `agy 进程启动失败: ${error.message}`;
        });
        proc.on('exit', (code) => {
            session.exited = true;
            if (session.exitNote === undefined) {
                session.exitNote = `agy 进程退出(code ${code ?? 'null'})`;
            }
            const active = session.active;
            if (active !== undefined && !active.finished) {
                active.exitedCode = code;
                active.finished = true;
                const wake = active.wake;
                active.wake = undefined;
                wake?.();
            }
            try {
                session.closeLines?.();
            }
            catch { /* 已关闭 */ }
            // 死进程不留在 Map:下一次 acquire 重建(带 --conversation)。
            if (this.sessions.get(sessionId) === session)
                this.sessions.delete(sessionId);
        });
        return session;
    }
    /** 杀会话进程(abort/会话失效/回收),含残留工具子进程。 */
    killSession(session, note) {
        if (session.exitNote === undefined)
            session.exitNote = note;
        try {
            session.proc.stdin?.end();
        }
        catch { /* 已关闭 */ }
        killProcessTree(session.proc);
        try {
            session.closeLines?.();
        }
        catch { /* 已关闭 */ }
        if (this.sessions.get(session.sessionId) === session)
            this.sessions.delete(session.sessionId);
    }
    /** 轮结束后的空闲回收:时长足够后台任务跑完;到时无新轮则关进程释放资源。 */
    armIdleRecycle(session) {
        if (session.exited)
            return;
        if (session.idleTimer !== undefined)
            clearTimeout(session.idleTimer);
        session.idleTimer = setTimeout(() => {
            session.idleTimer = undefined;
            if (session.active !== undefined)
                return;
            this.killSession(session, '空闲回收');
        }, SESSION_IDLE_RECYCLE_MS);
        session.idleTimer.unref?.();
    }
    // ────────────────────────── 行处理 ──────────────────────────
    /** 进程级行处理:翻译 + 工具事件落地 + 轮结算(全部按当前 active 归属)。 */
    onLine(session, line) {
        const active = session.active;
        if (active === undefined) {
            // 空闲期噪音(上一轮残留的收尾提示等):只在里面找 conversation id。
            if (session.conversationId === undefined) {
                const m = /"conversation_id":"([^"]+)"/.exec(line);
                if (m !== null && m[1] !== undefined)
                    session.conversationId = m[1];
            }
            return;
        }
        active.armIdle();
        const parsed = active.translator.push(line);
        if (parsed.conversationId !== undefined) {
            session.conversationId = parsed.conversationId;
            // init 一到就把 conversationId 持久化(有旧记录的只更新 id,锚点不动):
            // 进程此时若崩溃/stall 被杀,下一轮重建仍能 --conversation 恢复,
            // 而不是把整段会话丢掉重来。
            const record = this.conversations.get(session.sessionId);
            if (record !== undefined) {
                this.conversations.set(session.sessionId, { ...record, conversationId: parsed.conversationId });
            }
        }
        if (parsed.step !== undefined)
            this.handleToolStep(session, active, parsed.step);
        for (const chunk of parsed.chunks) {
            active.chunks.push(chunk);
        }
        if (parsed.chunks.length > 0) {
            const wake = active.wake;
            active.wake = undefined;
            wake?.();
        }
        if (parsed.final === true && !active.finished) {
            // result 是本轮终局;进程**继续存活**(同一 conversation 的后续轮用)。
            active.finished = true;
            const wake = active.wake;
            active.wake = undefined;
            wake?.();
        }
    }
    /** 工具步骤落地为会话事件(语义与旧 -p 实现一致,状态挂在轮上)。 */
    handleToolStep(session, active, step) {
        const { stepType, state, toolName, toolParams, stepIndex } = step;
        const target = active.session;
        if (stepType !== 'tool' || toolName === undefined || target === undefined)
            return;
        active.sawToolStep = true;
        const callId = agyCallId(toolName, stepIndex, active.attempt);
        if (state === 'ACTIVE') {
            // 去重:AGY 的工具参数流式生成,同一 step 的 ACTIVE 会来多次
            // (空壳 → 参数逐步补全)。tool/call 只落地第一次,重复落地会让前端
            // 装配器崩掉(received more than one start Match,实测毒死订阅流)。
            // 必须 continue 语义(直接返回,不碰后续行)——这里是行处理器,return 即跳过。
            if (stepIndex !== undefined && active.toolCallSeq.has(stepIndex))
                return;
            if (stepIndex !== undefined && toolParams !== undefined)
                active.stepParams.set(stepIndex, toolParams);
            // 文件变更类工具:执行前快照目标文件,DONE 时对比出本次改动(diff 补全)。
            if (stepIndex !== undefined && AGY_FILE_MUTATION_TOOLS.has(toolName)) {
                active.editSnapshots.set(stepIndex, readFileRaw(agyToolFilePath(toolParams)));
            }
            const ev = target.append('tool/call', {
                turn: active.turn,
                step: active.step,
                callId,
                name: toolName,
                arguments: JSON.stringify(toolParams ?? {}),
            });
            if (stepIndex !== undefined)
                active.toolCallSeq.set(stepIndex, ev.seq);
            const args = JSON.stringify(toolParams ?? {});
            active.translator.recentSteps.push({ toolName, args, status: 'running' });
            if (active.translator.recentSteps.length > 8) {
                active.translator.recentSteps.splice(0, active.translator.recentSteps.length - 8);
            }
            return;
        }
        if (state !== 'DONE' && state !== 'ERROR')
            return;
        // 去重:无配对 call 的 DONE/ERROR 直接忽略(processLine 里 return 只跳本步)。
        if (stepIndex === undefined || !active.toolCallSeq.has(stepIndex))
            return;
        const seq = active.toolCallSeq.get(stepIndex);
        const output = step.output;
        // 工具输出的 latin1→UTF-8 还原已在 translator(fixLatin1Deep)完成。
        // 失败时 output 可能为空、错误只在 tool_info.error 里,兜底取它。
        const textOut = typeof output === 'string' && output.length > 0
            ? output
            : typeof step.toolError === 'string' ? step.toolError : '';
        // 协议层识别后台任务状态(manage_task/command_status 输出里的 Task/Status):
        // 轮 result 后若仍有 RUNNING,dsh 会自动续轮等待——状态驱动,不赌模型自觉。
        collectTaskStates(active.tasks, textOut);
        // dsh 化补全:AGY 对文件类工具只回传路径/摘要(view_file)/空结果
        // (write/edit),正文与差异都在 AGY 进程内部。适配器按路径自行补全。
        const params = active.stepParams.get(stepIndex) ?? toolParams;
        const filePath = agyToolFilePath(params);
        // 补全含异步 IO(读图/附件提交):登记到轮上,轮收尾前统一完成,
        // 否则回合已结束而 tool/result 尚未落地(会话事件缺一条)。
        active.pendingEnrich.push(this.enrichToolResult(active, target, stepIndex, toolName, callId, textOut, filePath, state === 'ERROR')
            .catch(() => { }));
    }
    /** DONE/ERROR 的异步补全与落地(view_file 图片走附件通道;write/edit 附 diff)。 */
    async enrichToolResult(active, target, stepIndex, toolName, callId, textOut, filePath, isError) {
        const seq = active.toolCallSeq.get(stepIndex);
        let extra;
        let imageBlock;
        if (toolName === 'view_file') {
            const image = readImageFile(filePath);
            if (image !== undefined) {
                const ref = await commitImagePresentation(this.options.getAttachments?.(), image.data, image.mediaType, filePath !== undefined ? basename(filePath) : undefined);
                if (ref !== undefined)
                    imageBlock = { type: 'image', attachment: ref };
            }
            else {
                extra = enrichAgyToolResult(toolName, filePath);
            }
        }
        else {
            extra = enrichAgyToolResult(toolName, filePath, active.editSnapshots.get(stepIndex));
        }
        active.editSnapshots.delete(stepIndex);
        const text = extra === undefined
            ? textOut
            : textOut.length > 0 ? `${textOut}\n\n${extra}` : extra;
        target.append('tool/result', {
            turn: active.turn,
            step: active.step,
            message: createToolResultMessage({
                callId,
                content: [
                    { type: 'text', text: text.slice(0, 12000) },
                    ...imageBlock !== undefined ? [imageBlock] : [],
                ],
                isError,
            }),
        }, {
            surfaceOp: 'append',
            ...(seq !== undefined ? { sourceEventSeqs: [seq] } : {}),
        });
        const last = active.translator.recentSteps.at(-1);
        if (last !== undefined && last.toolName === toolName && last.status === 'running') {
            last.status = isError ? 'FAILED' : 'OK';
            if (isError)
                last.message = textOut.split('\n')[0]?.slice(0, 200) ?? 'unknown error';
        }
        // 收尾后从配对表移除:重复到达的 DONE/ERROR 会被忽略,不再落地幽灵结果。
        active.toolCallSeq.delete(stepIndex);
        active.stepParams.delete(stepIndex);
    }
    // ────────────────────────── 轮生命周期 ──────────────────────────
    /** 建立一轮:translator、工具事件上下文与动态空闲计时。 */
    beginTurn(session, options, attempt) {
        const to = {
            ...DEFAULT_AGY_RUN_TIMEOUTS,
            ...this.options.timeouts,
            // 旧配置 stallTimeoutMs 作为 idleMaxMs 的覆盖入口保持兼容。
            ...this.options.timeouts?.idleMaxMs === undefined && this.options.stallTimeoutMs !== undefined
                ? { idleMaxMs: this.options.stallTimeoutMs }
                : {},
        };
        // 工具步骤落地所需的 turn/step(从子代理会话推断)。
        const sessionFace = options.sessionId !== undefined
            ? this.ctx.get('sessions')?.get(options.sessionId)
            : undefined;
        const events = sessionFace?.ownEvents?.() ?? [];
        const turn = ([...events].reverse().find(e => e.type === 'turn/start')?.data.turn ?? 1);
        const step = ([...events].reverse().find(e => e.type === 'step/start')?.data.step ?? 1);
        const active = {
            attempt,
            translator: new AgyTranslator(),
            chunks: [],
            finished: false,
            stallTimedOut: false,
            maxGapMs: 0,
            lastLineAt: Date.now(),
            lineSamples: 0,
            lastBudgetMs: to.idleMaxMs,
            stallExtensions: 0,
            stallChecking: false,
            stallCheckSample: 0,
            touch: () => { },
            armIdle: () => { },
            hasOutput: false,
            sawToolStep: false,
            pendingEnrich: [],
            tasks: new Map(),
            ...(sessionFace !== undefined ? { session: sessionFace } : {}),
            turn,
            step,
            toolCallSeq: new Map(),
            stepParams: new Map(),
            editSnapshots: new Map(),
        };
        // stall 评估:静默到点不直接杀——先看 AGY 是否还有活跃子进程。
        // 持久模式下 AGY 等后台任务时 stdout 静默是预期行为(stderr 也会出
        // "root agent idle; waiting" 信号,由 stderr handler 直接续期);
        // 子进程消失(LLM 请求黑洞类死挂)才判定真死并杀进程树。
        const hasAliveChildren = (pid) => new Promise(resolve => {
            execFile('powershell.exe', ['-NoProfile', '-Command',
                `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Measure-Object).Count`], { timeout: 5_000 }, (err, stdout) => {
                if (err) {
                    resolve(false);
                    return;
                }
                const n = parseInt(String(stdout).trim(), 10);
                resolve(Number.isFinite(n) && n > 0);
            });
        });
        const evaluateStall = async () => {
            if (active.stallChecking || active.stallTimedOut || active.finished)
                return;
            active.stallChecking = true;
            active.stallCheckSample = active.lineSamples;
            const pid = session.proc.pid;
            const busy = pid !== undefined ? await hasAliveChildren(pid) : false;
            active.stallChecking = false;
            // 评估期间来了新进展(输出恢复)→ 正常续命,不消耗豁免次数。
            if (active.lineSamples > active.stallCheckSample) {
                active.touch();
                return;
            }
            if (busy && active.stallExtensions < 3) {
                // AGY 仍在管理它的后台线程:续命一个预算,最多 3 次(约 30 分钟)。
                active.stallExtensions += 1;
                active.touch();
                return;
            }
            active.stallTimedOut = true;
            this.killSession(session, 'stall 判定卡死');
            active.finished = true;
            const wake = active.wake;
            active.wake = undefined;
            wake?.();
        };
        active.touch = () => {
            if (active.firstTimer !== undefined) {
                clearTimeout(active.firstTimer);
                active.firstTimer = undefined;
            }
            if (active.idleTimer !== undefined)
                clearTimeout(active.idleTimer);
            active.idleTimer = setTimeout(() => { void evaluateStall(); }, active.lastBudgetMs);
        };
        active.armIdle = () => {
            const now = Date.now();
            active.maxGapMs = Math.max(active.maxGapMs, now - active.lastLineAt);
            active.lastLineAt = now;
            active.lineSamples += 1;
            active.lastBudgetMs = active.lineSamples <= to.idleWarmupLines
                ? to.idleMaxMs
                : Math.min(Math.max(active.maxGapMs * to.idleFactor, to.idleMinMs), to.idleMaxMs);
            active.touch();
        };
        // 首包超时(写入本轮消息到第一行输出;AGY 深度思考前可能静默)。
        active.touch();
        active.firstTimer = setTimeout(() => {
            if (active.lineSamples > 0 || active.finished)
                return;
            active.stallTimedOut = true;
            this.killSession(session, `首包超时(${Math.round(to.firstMs / 1000)}s)`);
            active.finished = true;
            const wake = active.wake;
            active.wake = undefined;
            wake?.();
        }, to.firstMs);
        return active;
    }
    /** 收束一轮:清计时器、解除 active、安排空闲回收。 */
    endTurn(session, active) {
        if (active.firstTimer !== undefined)
            clearTimeout(active.firstTimer);
        if (active.idleTimer !== undefined)
            clearTimeout(active.idleTimer);
        if (session.active === active)
            session.active = undefined;
        this.armIdleRecycle(session);
    }
    // ────────────────────────── 主流程 ──────────────────────────
    async *stream(options) {
        const sessionId = options.sessionId;
        if (sessionId === undefined) {
            // 持久进程按 dsh 会话键控;没有会话就没有跨轮上下文与续接记录可言。
            throw new Error('llm-agy: stream requires options.sessionId (persistent session keying)');
        }
        const model = options.model ?? this.options.model;
        const maxAttempts = this.options.maxAttempts ?? 5;
        const retryDelayMs = this.options.retryDelayMs ?? 15_000;
        // 续跑(本 dsh 会话已有 AGY conversation 记忆):按锚点补发 AGY 尚未
        // 见过的增量消息。绝不重发全量历史——token 开销巨大,且实测会被 AGY
        // 当作新任务从头重跑;锚点缺失/压缩时只发最后一条用户输入兜底。
        const prior = this.conversations.get(sessionId);
        const { prompt, cleanup } = prior !== undefined
            ? await resumeReplayPrompt(this.ctx, options.messages, prior.sentCount, prior.lastSentMessageId)
            : await buildPrompt(this.ctx, options);
        // AGY 是完整 harness CLI,自己在内部执行工具(浏览器/命令等);
        // 其工作目录对齐子代理会话的工作区,保证文件操作/截图发生在正确目录。
        const childSession = this.ctx.get('sessions')?.get(sessionId);
        const cwd = childSession?.header?.cwd ?? process.cwd();
        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (options.signal?.aborted)
                    throw options.signal.reason ?? new Error('aborted');
                const session = this.acquire(sessionId, cwd, prior?.conversationId);
                if (session.spawnError !== undefined) {
                    // 坏命令(不存在/参数非法):重试同一个只白等,直接报错。
                    throw new Error(`llm-agy: ${session.spawnError}`);
                }
                const active = this.beginTurn(session, options, attempt);
                session.active = active;
                const onAbort = () => {
                    this.killSession(session, '已中止');
                    if (!active.finished) {
                        active.finished = true;
                        const wake = active.wake;
                        active.wake = undefined;
                        wake?.();
                    }
                };
                options.signal?.addEventListener('abort', onAbort, { once: true });
                // 重试轮不能重发原任务(会被当作新消息重做一遍),而是明确指示
                // 继续未完成的工作(长驻进程与后台任务规则由运行时约束随行携带)。
                let text = attempt > 1 && session.conversationId !== undefined ? continuationPrompt() : prompt;
                try {
                    // 一次 stream() 可含多段 AGY 回合:result 到达时若协议层仍见 RUNNING
                    // 后台任务(从 manage_task/command_status 的工具输出解析,非提示词),
                    // dsh 主动续发"等待任务"指令——状态驱动的硬保险,不赌模型自觉。
                    for (let taskWait = 0;; taskWait += 1) {
                        const payload = JSON.stringify({
                            event: 'user',
                            message: { role: 'user', content: [{ type: 'text', text }] },
                        });
                        session.proc.stdin?.write(payload + '\n');
                        while (!active.finished) {
                            if (active.chunks.length > 0) {
                                const chunk = active.chunks.shift();
                                active.hasOutput = true;
                                yield chunk;
                                continue;
                            }
                            if (options.signal?.aborted)
                                break;
                            await new Promise((resolve) => { active.wake = resolve; });
                            active.wake = undefined;
                        }
                        // 工具结果补全的异步落地完成后再收尾(否则回合结束而 tool/result 未落地)。
                        await Promise.allSettled(active.pendingEnrich);
                        active.pendingEnrich.length = 0;
                        const pending = runningTaskIds(active.tasks);
                        if (options.signal?.aborted || active.stallTimedOut
                            || pending.length === 0 || taskWait >= MAX_TASK_WAIT_ROUNDS) {
                            break;
                        }
                        // 续轮:同进程同会话,再发一行等待指令;复用本 ActiveTurn(文本与
                        // 工具事件对 dsh 是一个连续回答),重置终局标记并重启计时。
                        text = `后台任务 ${pending.join('、')} 仍在运行:请用任务状态工具(manage_task / command_status)等待并轮询,`
                            + '直到它真正结束(或确凿失败)后再报告最终结果,不要以"稍后汇报"收尾。';
                        active.finished = false;
                        active.touch();
                    }
                    // 冲刷解码器残余字节(最后一段文本的尾字符可能被截断)。
                    for (const chunk of active.translator.flush()) {
                        active.hasOutput = true;
                        yield chunk;
                    }
                }
                finally {
                    options.signal?.removeEventListener('abort', onAbort);
                    this.endTurn(session, active);
                }
                // 中止:进程树已由 abort 监听器杀掉,立即收尾——不重试、不合成错误
                // (宿主会把本回合标记为 interrupted)。
                if (options.signal?.aborted)
                    return;
                const translator = active.translator;
                const resultError = translator.resultError;
                const stderrNote = session.stderrTail.trim().length > 0
                    ? `;stderr: ${session.stderrTail.trim().slice(-400)}`
                    : '';
                // stall 触发:动态阈值到点仍无 stdout 行且无活跃子进程。合成 retryable
                // 错误走恢复会话续跑(进程已杀,下一轮 acquire 重建时带 --conversation)。
                const stallNote = active.stallTimedOut
                    ? `retryable: agy stall timeout (no stdout line for ${Math.round(active.lastBudgetMs / 1000)}s;`
                        + ` history max gap ${Math.round(active.maxGapMs / 1000)}s, ${active.lineSamples} lines)`
                    : undefined;
                // 进程中途退出(非 stall/非会话失效):按 retryable 走重建续跑。
                const exitNote = !active.stallTimedOut && active.exitedCode !== undefined
                    ? `retryable: agy ${session.exitNote ?? '进程退出'}(本轮中断)`
                    : undefined;
                // 空回答:result 到了但既无文本也无工具步骤,且非 stall——不是合法
                // 空回复(冷启动认证/代理抖动等),合成 retryable 走既有重试。
                // 注意必须排除"文本只在 result.response 缓存"的情况(text_delta 未
                // 逐块输出时 hasOutput 仍为 false,但 end() 会产出完整文本)。
                const emptyAnswer = resultError === undefined && !active.hasOutput && !active.sawToolStep && !active.stallTimedOut
                    && active.exitedCode === undefined && !translator.hasContent
                    ? 'retryable: agy produced an empty turn (transient startup/upstream failure)'
                    : undefined;
                const baseError = resultError ?? stallNote ?? exitNote ?? session.spawnError ?? emptyAnswer;
                const effectiveError = baseError !== undefined ? baseError + stderrNote : undefined;
                // 会话失效(被清理/过期):不重试(重试只会重复失败),也绝不回退全量
                // 重发——杀掉常驻进程(其内部会话已失效),直接以错误收尾,由调用方
                // 决定重开任务还是放弃。
                const conversationLost = effectiveError !== undefined && CONVERSATION_LOST_RE.test(effectiveError);
                if (conversationLost) {
                    this.killSession(session, '会话失效');
                }
                const retryable = !conversationLost
                    && effectiveError !== undefined && RETRYABLE_ERROR_RE.test(effectiveError);
                // 上下文超限:只在 AGY 错误消息明确提到 context/limit/exceed 时才判定。
                const contextExhausted = resultError !== undefined && /context|token limit|window|exceed|maximum length|too large/i.test(resultError);
                // 执行反馈:失败时附最近执行轨迹,主代理能看到异常发生在哪个环节。
                const executionFeedbackBlocks = () => {
                    const steps = translator.recentSteps;
                    if (effectiveError === undefined && !contextExhausted)
                        return [];
                    const lines = [];
                    if (effectiveError !== undefined) {
                        lines.push(`**执行报错**:${effectiveError.slice(0, 250)}`);
                    }
                    if (contextExhausted) {
                        lines.push(`**AGY 报告上下文超限**,继续重试大概率无意义`);
                    }
                    const failed = steps.filter(s => s.status === 'FAILED');
                    if (failed.length > 0) {
                        lines.push(`**${failed.length} 步工具调用失败**`);
                    }
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
                // 成功:无执行错误且本轮有产出(或有合法的 result 终局)。
                if (effectiveError === undefined) {
                    // 续接记录写回:本次发送覆盖到当前全部消息(主锚=最后一条 id)。
                    // 只在成功收尾写——失败时保留旧锚点,下次从旧锚点补发,宁可重复
                    // 不可丢失(锚点过早写入会让进程死后的窗口丢消息,实测教训)。
                    if (session.conversationId !== undefined) {
                        const latest = options.messages.length === 0 ? undefined : options.messages[options.messages.length - 1];
                        this.conversations.set(sessionId, {
                            conversationId: session.conversationId,
                            sentCount: options.messages.length,
                            ...(latest === undefined ? {} : { lastSentMessageId: String(latest.id) }),
                        });
                    }
                    for (const chunk of translator.end())
                        yield chunk;
                    for (const chunk of executionFeedbackBlocks())
                        yield chunk;
                    return;
                }
                // retryable 网络/服务端错误:恢复同一会话续跑,不重头执行
                // (工具副作用与已输出文本都不会重复)。会话失效已在上面排除。
                if (retryable && !contextExhausted && attempt < maxAttempts) {
                    await new Promise(resolve => {
                        if (options.signal?.aborted) {
                            resolve();
                            return;
                        }
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
    resolveModel(provider, model, _signal) {
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
