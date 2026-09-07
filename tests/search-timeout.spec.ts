/**
 * AGY 搜索超时策略单元测试:
 * - AGY 是完整 agent,深度调研会持续几分钟(实测一次普通搜索约 54 秒),
 *   期间不断输出 step_update;按总时长一刀切会把正常长任务误杀;
 * - 因此采用"空闲超时":还在出活就续命,长时间没有任何输出才判卡死;
 * - 总时长上限兜底,且刻意小于宿主侧的 searchTimeoutMs,好让自己先优雅
 *   退出并给出明确错误,而不是被宿主硬掐。
 */
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import { Readable as ReadableStream } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AgySearchProvider } from '../src/search.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

/** 一条 AGY stream-json 行。 */
function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`
}

/** 成功的 result 行(含 response,会被提取为搜索结果)。 */
function resultLine(response: string): string {
  return line({ event: 'result', result: { status: 'SUCCESS', response } })
}

/**
 * 假 AGY 进程:按 `script` 逐条吐出,`script[i]` 为 `['emit', 行]` 或
 * `['wait', 毫秒]`,用来精确控制输出节奏。
 */
function fakeProc(script: readonly (readonly [string, string | number])[]):
  EventEmitter & { stdout: Readable; kill: () => void } {
  const proc = new EventEmitter() as EventEmitter & { stdout: Readable; kill: () => void }
  let cancelled = false
  // 真实进程被 kill 后 stdout 会关闭,for-await 才会结束;这里必须让 sleep
  // 提前醒来并把流走完,否则 search() 会一直挂在读取上(测试表现为超时)。
  let wake: (() => void) | undefined
  proc.kill = (): void => { cancelled = true; wake?.() }
  const sleep = (ms: number): Promise<void> => new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    wake = (): void => { clearTimeout(timer); resolve() }
  })
  proc.stdout = ReadableStream.from(
    (async function* () {
      for (const [kind, value] of script) {
        if (cancelled) return
        if (kind === 'wait') await sleep(value as number)
        else yield value as string
      }
    })(),
  )
  return proc
}

/** 用注入的小超时跑一次 search。 */
async function search(
  script: readonly (readonly [string, string | number])[],
  timeouts: {
    firstMs?: number
    idleMinMs?: number
    idleMaxMs?: number
    idleFactor?: number
    idleWarmupLines?: number
  },
): Promise<{ ok: true; content?: string } | { ok: false; error: string }> {
  mockedSpawn.mockClear()
  mockedSpawn.mockImplementation(() => fakeProc(script) as unknown as ReturnType<typeof spawn>)
  const provider = new AgySearchProvider({
    command: 'agy',
    model: 'gemini-3.7-flash-high',
    effort: 'high',
    timeouts,
  })
  try {
    const result = await provider.search({ query: 'q' } as never)
    return { ok: true, content: result.content }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

describe('AGY 搜索超时:动态空闲阈值,有输出就续期', () => {
  it('持续输出时不被空闲超时杀掉(总耗时远超单次静默阈值也照常返回)', async () => {
    // 每 120ms 一次输出 → 历史最大间隔 ≈120ms,阈值 = max(120×3, min) =
    // idleMinMs;只要间隔小于阈值就持续续命,没有任何总时长上限。
    const script: (readonly [string, string | number])[] = [
      ['emit', line({ event: 'init' })],
      ['wait', 120],
      ['emit', line({ event: 'step_update' })],
      ['wait', 120],
      ['emit', line({ event: 'step_update' })],
      ['wait', 120],
      ['emit', line({ event: 'step_update' })],
      ['wait', 120],
      ['emit', resultLine('https://example.com/a 标题: 示例')],
    ]
    const outcome = await search(script, { idleMinMs: 300, idleMaxMs: 5_000 })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.content).toContain('https://example.com/a')
  })

  it('静默超过动态阈值(下限)才判定卡死,错误信息带诊断', async () => {
    // 只吐 init(无样本),然后一直沉默:阈值 = idleMaxMs 宽容等待,
    // 这里注入小值验证按时失败。
    const script: (readonly [string, string | number])[] = [
      ['emit', line({ event: 'init' })],
      ['wait', 5000],
    ]
    const outcome = await search(script, { idleMinMs: 200, idleMaxMs: 400 })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('超时')
  })

  it('热身行数内一律宽容:间隔 300ms 的早期任务静默 500ms 不被误杀', async () => {
    // 行数 ≤ idleWarmupLines(默认 6):历史间隔还不足以预测后续静默,
    // 阈值 = idleMaxMs 宽容等待,静默 500ms(远大于间隔 300ms)应存活。
    const script: (readonly [string, string | number])[] = [
      ['emit', line({ event: 'init' })],
      ['wait', 300], ['emit', line({ event: 'step_update' })],
      ['wait', 300], ['emit', line({ event: 'step_update' })],
      ['wait', 300], ['emit', line({ event: 'step_update' })],
      ['wait', 500], ['emit', resultLine('https://example.com/deep 标题: 深度任务')],
    ]
    const outcome = await search(script, { idleMinMs: 200, idleMaxMs: 2_000 })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.content).toContain('https://example.com/deep')
  })

  it('样本足够后阈值按历史最大间隔收紧:静默超限被终止并带诊断', async () => {
    // warmup 收缩到 2 行:第 3 行起阈值 = clamp(maxGap×3, 200, 2000)。
    // 前 8 行间隔 100ms → maxGap≈100ms → 阈值 ≈300ms;随后静默 800ms 超限失败,
    // 错误信息必须带"历史最大行间隔"诊断。
    const script: (readonly [string, string | number])[] = [['emit', line({ event: 'init' })]]
    for (let i = 0; i < 8; i += 1) script.push(['wait', 100], ['emit', line({ event: 'step_update' })])
    script.push(['wait', 800], ['emit', resultLine('should not reach')])
    const outcome = await search(script, {
      idleMinMs: 200,
      idleMaxMs: 2_000,
      idleFactor: 3,
      idleWarmupLines: 2,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('历史最大行间隔')
  })

  it('样本足够后,间隔略超历史最大值但未超阈值时仍存活', async () => {
    // 同上收紧场景,但末尾静默 350ms < 阈值 300ms×(略高容差)——
    // 用 300ms 间隔(== maxGap,阈值 300ms 临界)改为 250ms 静默,
    // 250 < 300 应存活并正常返回。
    const script: (readonly [string, string | number])[] = [['emit', line({ event: 'init' })]]
    for (let i = 0; i < 8; i += 1) script.push(['wait', 100], ['emit', line({ event: 'step_update' })])
    script.push(['wait', 250], ['emit', resultLine('https://example.com/tail 标题: 尾部结果')])
    const outcome = await search(script, {
      idleMinMs: 200,
      idleMaxMs: 2_000,
      idleFactor: 3,
      idleWarmupLines: 2,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.content).toContain('https://example.com/tail')
  })

  it('完全无输出:首包超时先于空闲超时触发(卡启动/登录时快速失败)', async () => {
    const script: (readonly [string, string | number])[] = [['wait', 5000]]
    const started = Date.now()
    const outcome = await search(script, { firstMs: 200, idleMaxMs: 10_000 })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('无首行输出')
    // 不应该等到空闲阈值(10s)才失败。
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('没有总时长上限:持续输出永不因总时长被杀', async () => {
    // 间隔 100ms 的 24 行输出,总耗时 ~2.4s;任何"总时长上限"都会在
    // 有输出时误杀——现在只有静默才计时,该脚本必须自然跑完。
    const script: (readonly [string, string | number])[] = [['emit', line({ event: 'init' })]]
    for (let i = 0; i < 24; i += 1) script.push(['wait', 100], ['emit', line({ event: 'step_update' })])
    script.push(['emit', resultLine('https://example.com/long 标题: 长任务完成')])
    const outcome = await search(script, { idleMinMs: 200, idleMaxMs: 2_000 })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.content).toContain('https://example.com/long')
  })

  it('默认超时预算:首包 45s / 动态空闲 clamp [150s, 600s] × 3 / 热身 6 行', async () => {
    const { DEFAULT_AGY_RUN_TIMEOUTS } = await import('../src/agy-run.ts')
    expect(DEFAULT_AGY_RUN_TIMEOUTS).toEqual({
      firstMs: 45_000,
      idleMinMs: 150_000,
      idleMaxMs: 600_000,
      idleFactor: 3,
      idleWarmupLines: 6,
    })
  })
})

describe('AGY 搜索跟随设置面板', () => {
  it('options 用 getter 时每次搜索都重新取值:面板改代理即时生效', async () => {
    let proxy = 'http://127.0.0.1:1111'
    const options = {
      command: 'agy',
      model: 'gemini-3.7-flash-high',
      effort: 'high',
      timeouts: { idleMaxMs: 500 },
      // 模拟 index.ts 里设置面板驱动的 getter:优先面板 → 回退 config → 内建默认。
      get proxy(): string { return proxy },
    }
    mockedSpawn.mockClear()
    mockedSpawn.mockImplementation(() => fakeProc([['emit', resultLine('ok')]]) as unknown as ReturnType<typeof spawn>)

    const provider = new AgySearchProvider(options)
    await provider.search({ query: '第一次' } as never)
    proxy = 'http://127.0.0.1:2222' // 模拟用户在设置面板改代理
    await provider.search({ query: '第二次' } as never)

    const envOf = (call: number): Record<string, string> =>
      (mockedSpawn.mock.calls[call]?.[2] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expect(envOf(0).HTTPS_PROXY).toBe('http://127.0.0.1:1111')
    expect(envOf(0).ALL_PROXY).toBe('http://127.0.0.1:1111')
    // 关键:第二次调用读到的是新值,证明不是构造时就把代理定死了。
    expect(envOf(1).HTTPS_PROXY).toBe('http://127.0.0.1:2222')
    expect(envOf(1).ALL_PROXY).toBe('http://127.0.0.1:2222')
  })
})
