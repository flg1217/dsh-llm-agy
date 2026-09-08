/**
 * AGY 模型适配器:provider 路由 'agy'。
 * 对齐 llm-deepseek/adapter.ts 的结构:LLM 适配器负责 spawn 上游 + 用翻译模块
 * 产出 StreamChunk;工具步骤落地为会话事件(tool/call + tool/result)。
 * @module llm-agy/adapter
 */

import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { buildPrompt } from './serialize.js'
import { AgyTranslator, agyCallId } from './translate.js'
import { DEFAULT_AGY_RUN_TIMEOUTS } from './agy-run.js'

/** 适配器配置(由 index.ts 传入)。 */
export interface AgyAdapterOptions {
  command: string
  model: string
  effort: string
  extraArgs: string[]
  /** AGY 资格检查/API 流量代理;空字符串禁用。 */
  proxy?: string
  /** 启动级失败重试次数。 */
  maxAttempts?: number
  /** 启动级失败重试间隔(毫秒)。 */
  retryDelayMs?: number
  /**
   * 兼容旧配置:无输出兜底时长(ms,默认 10 分钟),作为动态空闲阈值的上限。
   * 动态阈值参数见 {@link AgyAdapterOptions.timeouts}。
   */
  stallTimeoutMs?: number
  /**
   * 动态空闲超时预算(默认见 {@link DEFAULT_AGY_RUN_TIMEOUTS}):热身行数内
   * 一律 idleMaxMs 宽容,样本足够后阈值 = clamp(历史最大行间隔 × factor,
   * idleMinMs, idleMaxMs)。无总时长上限——有 stdout 行就永远续期。
   */
  timeouts?: {
    firstMs?: number
    idleMinMs?: number
    idleMaxMs?: number
    idleFactor?: number
    idleWarmupLines?: number
  }
}

/**
 * 可重试的 AGY 执行错误(网络/服务端/登录态问题),匹配则恢复会话重试。
 * 认证类(not logged in / login / credential / token / unauthorized / expired)必须重试:
 * AGY 首调时会自动完成登录态刷新/认证(冷启动语言服务器 + token 加载),
 * 首次请求因此失败时,后续重试通常即可成功。
 */
const RETRYABLE_ERROR_RE = /retryable|network issue|connection|timeout|overloaded|unavailable|5\d\d|ECONN|ETIMEDOUT|not logged|login|credential|token source|unauthorized|expired/i

/** 进程树杀:AGY 残留的 npm/工具子进程会占端口、拖住输出流,必须 /T 递归。 */
function killProcessTree(proc: ChildProcess): void {
  try {
    if (proc.pid !== undefined) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        .on('error', () => { try { proc.kill() } catch { /* 已退出 */ } })
    }
  } catch { /* 已退出 */ }
  try { proc.kill() } catch { /* 已退出 */ }
  try { proc.stdout?.destroy() } catch { /* 已关闭 */ }
}

/** AGY 进程退出兜底:进程卡死(如上下文超限后挂起)时强制结束,
 * 保证 stream 一定会结束 → 子代理 agent 一定 idle → settle 通知必达。 */
async function closeWithTimeout(
  proc: ChildProcess,
  signal: AbortSignal | undefined,
  timeoutMs = 30_000,
): Promise<[number | null, string | null]> {
  const closePromise = once(proc, 'close') as Promise<[number | null, string | null]>
  let timer: ReturnType<typeof setTimeout> | undefined
  if (signal?.aborted) {
    killProcessTree(proc)
  } else {
    timer = setTimeout(() => {
      // 兜底:AGY 卡死(不退出、不输出)时杀掉,让调用方以错误收尾。
      killProcessTree(proc)
    }, timeoutMs)
  }
  try {
    return await closePromise
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * AGY 模型适配器。stream() 每次调用:
 * 序列化 prompt → spawn agy -p → 逐行翻译为 StreamChunk(实时) →
 * 工具步骤落地为会话事件 → usage/finish 收尾。
 */
export class AgyLlmAdapter extends LlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly options: AgyAdapterOptions,
  ) {
    super()
  }

  /**
   * 绑定模型元数据与分发流入口(rc.2+ 的 LlmAdapter 接口)。
   * 显式实现而非依赖基类:插件对宿主 dsh-llm 版本保持兼容
   * (rc.6 宿主不调用此方法;rc.2+ 宿主调用本实现)。
   */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const command = this.options.command
    // 请求级 model 优先(子代理可经 agentOptions.model 动态指定),回退到配置值。
    const model = options.model ?? this.options.model
    const effort = this.options.effort
    const maxAttempts = this.options.maxAttempts ?? 5
    const retryDelayMs = this.options.retryDelayMs ?? 15_000
    const { prompt, cleanup } = await buildPrompt(this.ctx, options)

    // AGY 是完整 harness CLI,自己在内部执行工具(浏览器/命令等);
    // 其工作目录对齐子代理会话的工作区,保证文件操作/截图发生在正确目录。
    const childSession = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined
    const cwd = childSession?.header.cwd ?? process.cwd()

    try {
      // 首次 AGY 会话 id:第 2 次尝试起用 --conversation 恢复续跑。
      let conversationId: string | undefined
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted')
        // 第 2 次起:复用首次 AGY 会话续跑,而不是重头执行;
        // 中途偶发网络错误重试时不会重复已完成的工具操作与文本。
        // 续跑 prompt 不能是原任务(会被当作新消息重做一遍),而是明确指示
        // 继续未完成的工作、不要重复已完成部分;并明确禁止前台运行长驻进程——
        // 实测 AGY 用 Bash 前台跑 npm run dev 会永不返回,把整次调用拖进
        // stall 超时(重试后又犯,拖满重试次数)。
        const attemptPrompt = attempt > 1 && conversationId !== undefined
          ? '继续完成之前未完成的任务。基于当前工作区状态继续,不要重复已完成的工作,只报告新做的内容。'
            + '注意:不要用 Bash 前台运行长驻进程(npm run dev / npm start / 服务器等)——它们永不返回会导致你卡死;'
            + '如需启动服务验证,用后台方式(nohup ... & 或 start /B)启动,然后用 curl 轮询端口就绪。'
          : prompt
        const resumeArgs = attempt > 1 && conversationId !== undefined
          ? ['--conversation', conversationId]
          : []
        // 模型名自带强度后缀(gemini-3.8-flash-high 等)时,AGY 拒绝再传
        // --effort("--model X conflicts with --effort=Y"),此时静默省略。
        const effortArgs = /-(low|medium|high)$/i.test(model) ? [] : ['--effort', effort]
        const proc: ChildProcess = spawn(command, [
          '-p', attemptPrompt,
          '--output-format', 'stream-json',
          // AGY 默认 print-timeout 5 分钟,长任务会超时退出 1;放宽到 1 小时。
          '--print-timeout', '60m',
          '--model', model,
          ...effortArgs,
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
        })
        if (proc.stdout === null) {
          proc.kill()
          throw new Error('llm-agy: agy process has no stdout stream')
        }

        const onAbort = (): void => { killTree() }
        options.signal?.addEventListener('abort', onAbort, { once: true })

        // 动态空闲超时(与 agy-run 搜索/读图执行器同一套算法):AGY 深度思考
        // 期间 stdout 可静默 1~3 分钟,固定阈值必然误杀;按本次调用已观测的
        // 最大行间隔自适应 clamp(最大间隔 × factor, min, max),热身行数内
        // 一律 idleMaxMs 宽容。触发时除 kill 外必须 destroy stdout——AGY 内部
        // 工具(浏览器/shell)的进程树可能残留并持有 stdout 写端,只 kill 的
        // 话 for-await 会永久挂起,子代理假死(实测)。无总时长上限——有
        // stdout 行就永远续期。
        const to = {
          ...DEFAULT_AGY_RUN_TIMEOUTS,
          ...this.options.timeouts,
          // 旧配置 stallTimeoutMs 作为 idleMaxMs 的覆盖入口保持兼容。
          ...this.options.timeouts?.idleMaxMs === undefined && this.options.stallTimeoutMs !== undefined
            ? { idleMaxMs: this.options.stallTimeoutMs }
            : {},
        }
        const startedAt = Date.now()
        let stallTimedOut = false
        let firstTimer: ReturnType<typeof setTimeout> | undefined
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        let maxGapMs = 0
        let lastLineAt = startedAt
        let lineSamples = 0
        let lastBudgetMs = to.idleMaxMs
        // stall 评估:静默到点不直接杀——先看 AGY 是否还有活跃子进程。
        // AGY 的 Bash 会把 dev server 等长驻命令自动后台化,之后 AGY 在正常
        // 工作(等编译完成/轮询就绪),期间 stream-json 静默是预期行为;
        // 此时杀掉等于杀死正在干活的任务。子进程消失(LLM 请求黑洞类死挂,
        // AGY 单独存在)才判定真死并杀进程树。
        let stallExtensions = 0
        let stallChecking = false
        let stallCheckSample = 0
        const killTree = (): void => {
          // 进程树杀:残留的 npm/工具子进程会占端口、拖住输出流。
          try {
            if (proc.pid !== undefined) {
              spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
                .on('error', () => { try { proc.kill() } catch { /* 已退出 */ } })
            }
          } catch { /* 已退出 */ }
          try { proc.kill() } catch { /* 已退出 */ }
          // 进程树残留可能仍持有 stdout 写端,必须同时关流,for-await 才能结束。
          try { proc.stdout?.destroy() } catch { /* 已关闭 */ }
        }
        const hasAliveChildren = (pid: number): Promise<boolean> => new Promise(resolve => {
          execFile('powershell.exe', ['-NoProfile', '-Command',
            `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Measure-Object).Count`],
          { timeout: 5_000 }, (err, stdout) => {
            if (err) { resolve(false); return }
            const n = parseInt(String(stdout).trim(), 10)
            resolve(Number.isFinite(n) && n > 0)
          })
        })
        const evaluateStall = async (): Promise<void> => {
          if (stallChecking || stallTimedOut) return
          stallChecking = true
          stallCheckSample = lineSamples
          const pid = proc.pid
          const busy = pid !== undefined ? await hasAliveChildren(pid) : false
          stallChecking = false
          // 评估期间来了新进展(输出恢复)→ 正常续命,不消耗豁免次数。
          if (lineSamples > stallCheckSample) {
            touch()
            return
          }
          if (busy && stallExtensions < 3) {
            // AGY 仍在管理它的后台线程:续命一个预算,最多 3 次(约 30 分钟)。
            stallExtensions += 1
            touch()
            return
          }
          stallTimedOut = true
          killTree()
        }
        const failStall = (): void => {
          void evaluateStall()
        }
        const touch = (): void => {
          // 续命:按当前预算重置静默计时;首个活动同时撤销首包超时。
          if (firstTimer !== undefined) {
            clearTimeout(firstTimer)
            firstTimer = undefined
          }
          if (idleTimer !== undefined) clearTimeout(idleTimer)
          idleTimer = setTimeout(failStall, lastBudgetMs)
        }
        const armIdle = (): void => {
          const now = Date.now()
          maxGapMs = Math.max(maxGapMs, now - lastLineAt)
          lastLineAt = now
          lineSamples += 1
          lastBudgetMs = lineSamples <= to.idleWarmupLines
            ? to.idleMaxMs
            : Math.min(Math.max(maxGapMs * to.idleFactor, to.idleMinMs), to.idleMaxMs)
          touch()
        }
        touch()
        // stderr 只收集不续命:AGY 内部工具的孙进程会继承 stderr 写端,长进程
        // (dev server 等)的零星输出若参与续命就会永不超时(实测假死)。
        // 任务进展的唯一真信号是 stdout 的 stream-json 行;stderr 仅作归因证据。
        let stderrTail = ''
        if (proc.stderr !== null && proc.stderr !== undefined) {
          proc.stderr.setEncoding('utf8')
          proc.stderr.on('data', (chunk: string) => {
            stderrTail = (stderrTail + chunk).slice(-4000)
          })
        }

        // 工具步骤落地为会话事件所需的 turn/step(从子代理会话推断)。
        const session = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined
        const events = session?.ownEvents?.() ?? []
        const turn = ([...events].reverse().find(e => e.type === 'turn/start')?.data.turn ?? 1) as number
        const step = ([...events].reverse().find(e => e.type === 'step/start')?.data.step ?? 1) as number
        const toolCallSeq = new Map<number, SessionSeq>() // step_index → tool/call seq

        const translator = new AgyTranslator()
        let hasOutput = false
        let sawToolStep = false
        try {
          // 字节级读取 + 流式解码:AGY 的 text_delta 按字节切分,
          // latin1 保留原始字节,TextDecoder 流式跨事件恢复完整字符。
          proc.stdout.setEncoding('latin1')
          const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity })
          for await (const line of rl) {
            if (options.signal?.aborted) {
              proc.kill()
              break
            }
            // 还在出活就续命(stdout 行:采样 + 续命;首包一到撤销首包超时)。
            armIdle()
            const { chunks, step: agyStep, conversationId: cid, final } = translator.push(line)
            if (cid !== undefined) conversationId = cid
            for (const chunk of chunks) {
              hasOutput = true
              yield chunk
            }
            // result 即 AGY 终局事件:收到后停止读取——后续行只有收尾噪音
            // (如流断开时的 "The stream was interrupted" 提示),解析它们会把
            // 成功的任务误判为失败。进程本身会在 closeWithTimeout 自然收尾。
            if (final === true) break
            if (agyStep !== undefined && session !== undefined) {
              const { stepType, state, toolName, toolParams, stepIndex } = agyStep
              if (stepType === 'tool' && toolName !== undefined) {
                sawToolStep = true
                const callId = agyCallId(toolName, stepIndex, attempt)
                if (state === 'ACTIVE') {
                  const ev = session.append('tool/call', {
                    turn,
                    step,
                    callId,
                    name: toolName,
                    arguments: JSON.stringify(toolParams ?? {}),
                  })
                  if (stepIndex !== undefined) toolCallSeq.set(stepIndex, ev.seq)
                  // 记录最近执行步骤(完整参数):反馈时主代理能看到异常发生在哪一步。
                  const args = JSON.stringify(toolParams ?? {})
                  translator.recentSteps.push({ toolName, args, status: 'running' })
                  if (translator.recentSteps.length > 8) translator.recentSteps.splice(0, translator.recentSteps.length - 8)
                } else if (state === 'DONE' || state === 'ERROR') {
                  const seq = stepIndex !== undefined ? toolCallSeq.get(stepIndex) : undefined
                  const output = agyStep.output
                  // 工具输出的 latin1→UTF-8 还原已在 translator(fixLatin1Deep)完成。
                  // 失败时 output 可能为空、错误只在 tool_info.error 里,兜底取它。
                  const textOut = typeof output === 'string' && output.length > 0
                    ? output
                    : typeof agyStep.toolError === 'string' ? agyStep.toolError : ''
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
                  })
                  // 更新最近步骤的结果状态。
                  const last = translator.recentSteps.at(-1)
                  if (last !== undefined && last.toolName === toolName && last.status === 'running') {
                    last.status = state === 'ERROR' ? 'FAILED' : 'OK'
                    if (state === 'ERROR') {
                      last.message = textOut.split('\n')[0]?.slice(0, 200) ?? 'unknown error'
                    }
                  }
                }
              }
            }
          }
          // 冲刷解码器残余字节(最后一段文本的尾字符可能被截断)。
          for (const chunk of translator.flush()) {
            hasOutput = true
            yield chunk
          }
        } finally {
          if (firstTimer !== undefined) clearTimeout(firstTimer)
          if (idleTimer !== undefined) clearTimeout(idleTimer)
          options.signal?.removeEventListener('abort', onAbort)
        }

        const [code] = await closeWithTimeout(proc, options.signal)
        const resultError = translator.resultError
        // stderr 尾巴只作证据附加(含 spawn 失败/工具报错等归因信息)。
        const stderrNote = stderrTail.trim().length > 0
          ? `;stderr: ${stderrTail.trim().slice(-400)}`
          : ''
        // stall 触发:动态阈值到点仍无 stdout 行。合成 retryable 错误走恢复
        // 会话续跑(--conversation 保留已完成部分)。
        const stallNote = stallTimedOut
          ? `retryable: agy stall timeout (no stdout line for ${Math.round(lastBudgetMs / 1000)}s;`
            + ` history max gap ${Math.round(maxGapMs / 1000)}s, ${lineSamples} lines)`
          : undefined
        // AGY 偶发"冷启动即静默退出、零输出"(认证/代理预检抖动,stderr 也无报错)。
        // 零输出且零工具步骤不是合法的空回答,合成 retryable 错误走既有重试。
        // 退出码非 0 的静默退出同样不是合法空回答。
        const silentEmptyExit = resultError === undefined && !hasOutput && !sawToolStep && !stallTimedOut
          ? (code === 0
            ? 'retryable: agy exited with code 0 but produced no output (transient startup failure)'
            : `retryable: agy exited with code ${code ?? 'null'} but produced no output`)
          : undefined
        const baseError = resultError ?? stallNote ?? silentEmptyExit
        const effectiveError = baseError !== undefined ? baseError + stderrNote : undefined
        const retryable = effectiveError !== undefined && RETRYABLE_ERROR_RE.test(effectiveError)
        // 上下文超限:只在 AGY 错误消息明确提到 context/limit/exceed 时才判定。
        // 不能用 usage 累加判断——AGY 会自动裁剪上下文,input_tokens 是增量累加,
        // 累加值(总消耗)不代表单次请求大小,会误报。
        const contextExhausted = resultError !== undefined && /context|token limit|window|exceed|maximum length|too large/i.test(resultError)
        // 执行反馈:无论什么失败(工具错、收尾网络错、上下文超限)都反馈给外层。
        // 任何异常都附上最近的完整执行轨迹,主代理能看到异常发生在哪个环节。
        const executionFeedbackBlocks = (): StreamChunk[] => {
          const steps = translator.recentSteps
          // 只在 AGY 整体失败(result ERROR / 静默零输出 / 上下文超限)时反馈。
          // 单步工具失败不算:AGY 经常自行重试或绕过后正常完成任务,此时
          // 在成功的报告后面拖一段"执行异常反馈"只会误导主代理。
          if (effectiveError === undefined && !contextExhausted) return []
          const lines: string[] = []
          if (effectiveError !== undefined) {
            lines.push(`**执行报错**:${effectiveError.slice(0, 250)}`)
          }
          if (contextExhausted) {
            lines.push(`**AGY 报告上下文超限**,继续重试大概率无意义`)
          }
          const failed = steps.filter(s => s.status === 'FAILED')
          if (failed.length > 0) {
            lines.push(`**${failed.length} 步工具调用失败**`)
          }
          // 异常发生的位置:总是附上最近的执行轨迹。
          if (steps.length > 0) {
            lines.push(`**最近执行步骤**(异常发生在这里,前 8 步):`)
            lines.push(...steps.map(s => {
              const mark = s.status === 'FAILED' ? '✗ FAILED' : s.status === 'OK' ? '✓ OK' : '… running'
              return `  - ${s.toolName} ${s.args} → ${mark}${s.message !== undefined ? ` | ${s.message}` : ''}`
            }))
          }
          const idx = translator.nextIndex + 1
          const text = `[AGY 子代理执行异常反馈]\n${lines.join('\n')}`
          return [
            { type: 'block-start', index: idx, blockType: 'text' },
            { type: 'text-delta', index: idx, text },
            { type: 'block-end', index: idx, block: { type: 'text', text } },
          ]
        }
        // 成功:无执行错误且(正常退出或已有输出)。静默零输出被有效错误覆盖,不在此列。
        if (effectiveError === undefined && (code === 0 || hasOutput)) {
          for (const chunk of translator.end()) yield chunk
          for (const chunk of executionFeedbackBlocks()) yield chunk
          return
        }
        // retryable 网络/服务端错误(AGY result ERROR 或 code!=0):恢复同一会话续跑,
        // 不重头执行(工具副作用与已输出文本都不会重复)。
        if (retryable && !contextExhausted && attempt < maxAttempts) {
          await new Promise<void>(resolve => {
            const t = setTimeout(resolve, retryDelayMs)
            options.signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
          })
          continue
        }
        // 非 retryable 或重试用尽:产出 finish 错误。
        for (const chunk of translator.end()) yield chunk
        for (const chunk of executionFeedbackBlocks()) yield chunk
        return
      }
    } finally {
      await cleanup()
    }
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      // AGY 由 Gemini 驱动,支持文本与图像输入(视觉看图子代理依赖此项)。
      inputModalities: ['text', 'image'],
      context: { contextWindow: 1_000_000 },
    })
  }
}
