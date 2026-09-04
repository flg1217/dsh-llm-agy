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
   * 超时预算(全部可选):
   * - `firstMs`: 首包超时,默认 45s(正常约 8s);
   * - `idleMs`: 空闲超时,默认 60s(持续输出就续命);
   * - `totalMs`: 总时长软上限,默认 10 分钟。
   */
  timeouts?: { firstMs?: number; idleMs?: number; totalMs?: number }
}

/** 默认超时预算。 */
export const DEFAULT_AGY_RUN_TIMEOUTS = {
  firstMs: 45_000,
  idleMs: 60_000,
  totalMs: 600_000,
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
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
    env: proxy
      ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy }
      : { ...process.env },
  })

  const firstMs = options.timeouts?.firstMs ?? DEFAULT_AGY_RUN_TIMEOUTS.firstMs
  const idleMs = options.timeouts?.idleMs ?? DEFAULT_AGY_RUN_TIMEOUTS.idleMs
  const totalMs = options.timeouts?.totalMs ?? DEFAULT_AGY_RUN_TIMEOUTS.totalMs
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
  let totalTimer: ReturnType<typeof setTimeout> | undefined

  /** 判定失败:记录原因(先到为准)、杀进程、并强制结束等待。 */
  const fail = (reason: string): void => {
    if (resultError !== undefined) return
    resultError = reason
    try { proc.kill() } catch { /* 已退出 */ }
    try { proc.stdout?.destroy() } catch { /* 已关闭 */ }
    finishNow()
  }

  firstTimer = setTimeout(() => {
    fail(`AGY 调用超时(${Math.round(firstMs / 1000)}s 无首行输出)`)
  }, firstMs)
  totalTimer = setTimeout(() => {
    fail(`AGY 调用超时(总时长超过 ${Math.round(totalMs / 1000)}s)`)
  }, totalMs)
  // 空闲超时:还在出活就续命。
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      fail(`AGY 调用超时(空闲 ${Math.round(idleMs / 1000)}s 无输出)`)
    }, idleMs)
  }
  armIdle()

  let response: string | undefined
  const clearTimers = (): void => {
    for (const t of [firstTimer, idleTimer, totalTimer]) if (t !== undefined) clearTimeout(t)
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
        // 还在出活就续命;首包一到就撤销首包超时。
        armIdle()
        if (firstTimer !== undefined) { clearTimeout(firstTimer); firstTimer = undefined }
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
