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

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** 一次 AGY print 调用的参数。 */
export interface AgyRunTextOptions {
  /** 可 spawn 的可执行文件。 */
  command: string
  /** 传给 `-p` 的任务提示词。 */
  prompt: string
  /** 代理地址(可选)。 */
  proxy?: string
  /** 模型(可选,不传用 AGY 默认)。 */
  model?: string
  /** 推理强度(可选)。 */
  effort?: string
  /** 工作目录(可选)。 */
  cwd?: string
  /** 调用方取消信号。 */
  signal?: AbortSignal
  /**
   * 超时预算(全部可选,默认见 {@link DEFAULT_AGY_RUN_TIMEOUTS}):
   * - `firstMs`: 首包超时;
   * - `idleMinMs` / `idleMaxMs`: 动态空闲阈值的下限/上限;
   * - `idleFactor`: 阈值 = clamp(历史最大行间隔 × factor, min, max);
   * - `idleWarmupLines`: 行数未到此样本数之前一律用 idleMaxMs 宽容
   *   (任务早期的历史间隔还不足以预测后续的深度思考静默)。
   */
  timeouts?: {
    firstMs?: number
    idleMinMs?: number
    idleMaxMs?: number
    idleFactor?: number
    idleWarmupLines?: number
  }
}

/** 默认超时预算:空闲阈值随历史输出间隔自适应,无总时长上限(有输出即续期)。
 * AGY(尤其 gemini-3.8-high 这类 thinking 模型)在深度思考/内部执行期间
 * stdout 可以静默 1~3 分钟以上,固定阈值必然误杀——故按本次调用已观测的
 * 最大行间隔自适应:热身行数内用 idleMaxMs 宽容(早期的历史间隔还预测不了
 * 后续的长静默),样本足够后阈值收紧到 clamp(最大间隔 × factor, min, max)。
 * 真卡死由 idleMaxMs 死线与 AGY 自身 --print-timeout(60 分钟)兜底。 */
export const DEFAULT_AGY_RUN_TIMEOUTS = {
  firstMs: 45_000,
  idleMinMs: 150_000,
  idleMaxMs: 600_000,
  idleFactor: 3,
  idleWarmupLines: 6,
}

/**
 * 跑一次 AGY print 调用并返回 `result.response` 文本。
 * @throws AGY 显式报错、超时、无输出时抛出带原因的 Error。
 */
export async function runAgyText(options: AgyRunTextOptions): Promise<string> {
  const command = options.command
  const proxy = options.proxy
  // 模型名自带强度后缀(gemini-3.8-flash-high 等)时,AGY 拒绝再传 --effort
  // ("--model X conflicts with --effort=Y"),此时静默省略 --effort。
  const modelEffortSuffix = /-(low|medium|high)$/i.exec(options.model ?? '') !== null
  const effortArgs = options.effort !== undefined
    && options.effort.length > 0
    && !modelEffortSuffix
    ? ['--effort', options.effort]
    : []
  const proc = spawn(command, [
    '-p', options.prompt,
    '--output-format', 'stream-json',
    // AGY 默认 print-timeout 5 分钟,长任务会超时退出 1;放宽到 1 小时
    // (真正的卡死检测由下面的空闲超时负责)。
    '--print-timeout', '60m',
    ...(options.model !== undefined && options.model.length > 0 ? ['--model', options.model] : []),
    ...effortArgs,
    '--dangerously-skip-permissions',
  ], {
    ...options.cwd !== undefined ? { cwd: options.cwd } : {},
    // stderr 收为管道:登录/代理/网络错误都打在这里,收集尾部用于错误归因。
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: proxy
      ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy }
      : { ...process.env },
  })

  const firstMs = options.timeouts?.firstMs ?? DEFAULT_AGY_RUN_TIMEOUTS.firstMs
  const idleMinMs = options.timeouts?.idleMinMs ?? DEFAULT_AGY_RUN_TIMEOUTS.idleMinMs
  const idleMaxMs = options.timeouts?.idleMaxMs ?? DEFAULT_AGY_RUN_TIMEOUTS.idleMaxMs
  const idleFactor = options.timeouts?.idleFactor ?? DEFAULT_AGY_RUN_TIMEOUTS.idleFactor
  const idleWarmupLines = options.timeouts?.idleWarmupLines ?? DEFAULT_AGY_RUN_TIMEOUTS.idleWarmupLines
  const startedAt = Date.now()
  let resultError: string | undefined
  let lines = 0

  // 超时后必须能真的往下走:readline 的迭代可能因为进程树残留而永不结束,
  // 所以除了 kill,还要关掉 readline 与 stdout,并直接放行 done。
  let finish: (() => void) | undefined
  const done = new Promise<void>((resolve) => { finish = resolve })
  const finishNow = (): void => { finish?.() }

  let firstTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  let response: string | undefined
  /** stderr 尾部(错误归因用)。 */
  let stderrTail = ''
  const stderrNote = (): string => stderrTail.trim().length > 0
    ? `;stderr: ${stderrTail.trim().slice(-400)}`
    : ''

  /** 判定失败:记录原因(先到为准)、杀进程、并强制结束等待。 */
  const fail = (reason: string): void => {
    if (resultError !== undefined) return
    resultError = reason + stderrNote()
    try { proc.kill() } catch { /* 已退出 */ }
    try { proc.stdout?.destroy() } catch { /* 已关闭 */ }
    finishNow()
  }

  // CLI 自己的错误信号,优先于任何计时器:
  // - `error`:spawn 本身失败(ENOENT/权限)——立即失败,不等首包超时;
  // - `close`:进程退出但没有产出结果(response/resultError 都为空)——
  //   CLI 崩溃/自报失败却没走 result 事件时立即归因,不等空闲超时。
  proc.on('error', (error: Error) => {
    fail(`AGY 进程启动失败:${error.message}`)
  })
  proc.on('close', (code, childSignal) => {
    if (response !== undefined || resultError !== undefined) return
    if (options.signal?.aborted) return
    fail(`AGY 进程退出(code ${code ?? 'null'}${childSignal !== null ? `,signal ${childSignal}` : ''})但未产出结果`)
  })

  firstTimer = setTimeout(() => {
    fail(`AGY 调用超时(${Math.round(firstMs / 1000)}s 无首行输出)`)
  }, firstMs)

  // 动态空闲判定:每行输出都续期;热身行数内一律 idleMaxMs 宽容(任务早期
  // 的历史间隔还不足以预测后续的深度思考静默),样本足够后阈值按本次调用
  // 已观测的最大行间隔自适应(clamp 在 [idleMinMs, idleMaxMs])。
  // 没有总时长上限——有输出就永远续期。
  let maxGapMs = 0
  let lastLineAt = startedAt
  let lineSamples = 0
  let lastBudgetMs = idleMaxMs
  const touch = (): void => {
    // 续命:按当前预算重置静默计时;首个活动同时撤销首包超时。
    if (firstTimer !== undefined) {
      clearTimeout(firstTimer)
      firstTimer = undefined
    }
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      fail(`AGY 调用超时(静默超过 ${Math.round(lastBudgetMs / 1000)}s 无输出;`
        + `本次历史最大行间隔 ${Math.round(maxGapMs / 1000)}s,阈值 = clamp(间隔 × ${idleFactor}, `
        + `${Math.round(idleMinMs / 1000)}s, ${Math.round(idleMaxMs / 1000)}s),已收 ${lineSamples} 行)`)
    }, lastBudgetMs)
  }
  const armIdle = (): void => {
    const now = Date.now()
    maxGapMs = Math.max(maxGapMs, now - lastLineAt)
    lastLineAt = now
    lineSamples += 1
    lastBudgetMs = lineSamples <= idleWarmupLines
      ? idleMaxMs
      : Math.min(Math.max(maxGapMs * idleFactor, idleMinMs), idleMaxMs)
    touch()
  }

  // stderr 活动(重试/进度日志)只续命不采样:密集日志不应把 stdout 行间隔
  // 样本污染收紧,但它确实证明进程活着。
  if (proc.stderr !== null && proc.stderr !== undefined) {
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000)
      touch()
    })
  }

  const clearTimers = (): void => {
    for (const t of [firstTimer, idleTimer]) if (t !== undefined) clearTimeout(t)
  }
  try {
    if (proc.stdout === null) throw new Error('AGY 进程没有 stdout')
    proc.stdout.setEncoding('latin1')
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity })
    const iterate = async (): Promise<void> => {
      for await (const line of rl) {
        lines += 1
        if (resultError !== undefined) break
        if (options.signal?.aborted) {
          resultError = undefined
          try { proc.kill() } catch { /* 已退出 */ }
          break
        }
        // 还在出活就续命(stdout 行:采样 + 续命;首包一到撤销首包超时)。
        armIdle()
        if (!line.trim().startsWith('{')) continue
        try {
          const evt = JSON.parse(line) as {
            event?: string
            result?: { status?: string; response?: unknown; error?: unknown }
          }
          if (evt.event === 'result') {
            const r = evt.result
            if (r?.status === 'SUCCESS' && typeof r.response === 'string' && r.response.length > 0) {
              response = Buffer.from(r.response, 'latin1').toString('utf8')
              // 答案到手就走,不等 stdout 自然关闭(尾巴可能是进程清理)。
              break
            } else if (r?.status === 'ERROR' && typeof r.error === 'string') {
              resultError = Buffer.from(r.error, 'latin1').toString('utf8').slice(0, 300)
              break
            }
          }
        } catch { /* 非 JSON 行跳过 */ }
      }
    }
    void iterate().catch((error: unknown) => {
      fail(`AGY 输出读取失败:${error instanceof Error ? error.message : String(error)}`)
    }).finally(finishNow)
    await done
  } finally {
    clearTimers()
    try { proc.kill() } catch { /* 已退出 */ }
  }
  const elapsed = Math.round((Date.now() - startedAt) / 1000)
  if (resultError !== undefined) {
    throw new Error(`AGY 调用失败:${resultError}(已等待 ${elapsed}s,收到 ${lines} 行输出)`)
  }
  if (response === undefined) {
    throw new Error(options.signal?.aborted
      ? 'AGY 调用已取消'
      : `AGY 调用无输出(已等待 ${elapsed}s,收到 ${lines} 行输出)`)
  }
  return response
}
