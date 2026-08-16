/**
 * AGY 搜索 provider:把 AGY 的 search_web 工具接入 dsh 的 ctx.web 搜索框架。
 * 对齐 dsh-web-search-deepseek/provider 的结构:
 * - available() 只做本地可用性检查(不联网);
 * - search() spawn AGY 执行一次搜索,解析 result.response 提取 sources。
 *
 * 限制(实测):
 * - AGY 的 search_web 不通过 stream-json 暴露结构化结果(tool_info.output 为空),
 *   只有 result.response 里是模型总结后的文本,需正则提取 URL/标题;
 * - 返回的 URL 是 Google Vertex AI grounding 重定向链接(可点击,非原始 URL);
 * - 每次搜索 = 一次完整 AGY 调用(约 34K input tokens / 5-10 秒)。
 * @module llm-agy/search
 */

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

/** AGY 搜索结果响应里提取 URL(标题行常见 `**标题**: thepaper.cn` / `**URL**: https://...`)。 */
const URL_RE = /https?:\/\/[^\s\)\]\}<>"']+/g

/** 提取一段响应文本中的标题。尝试从 `标题[：:]\s*(\S+)` 取。 */
function titleOf(line: string, url: string): string | undefined {
  const m = line.match(/[标题|title][：:]\s*([^\n|]+)/i)
  if (m) {
    const t = m[1].trim()
    if (t.length > 0 && t !== url) return t
  }
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

/** AGY 搜索 provider 配置(复用 llm-agy 的 AGY 参数)。 */
export interface AgySearchOptions {
  command: string
  model: string
  effort: string
  proxy?: string
}

/**
 * 一个 AGY 搜索 provider。
 * search() 通过 spawn `agy -p "搜索 <query>"` 执行,解析 result.response 为 sources。
 */
export class AgySearchProvider implements WebSearchProvider {
  readonly id = 'agy'

  constructor(private readonly options: AgySearchOptions) {}

  /** 本地可用性:命令存在即可;不做联网检查。 */
  available(): boolean {
    const r = spawnSync(this.options.command, ['--version'], { stdio: 'ignore', windowsHide: true })
    return r.error === undefined
  }

  /** 执行一次 AGY 搜索。 */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const query = request.query
    // AGY 是完整 agent:给它正常任务,它会自己调用 search_web 搜索、打开
    // 来源阅读全文,并综合提取总结。语言跟随用户提问,不固定。
    const prompt = `搜索:"${query}",综合所有相关来源,给出完整、准确、详尽的回答,并在回答中引用来源。`

    const resultText = await this.runAgy(prompt, signal)
    if (resultText === undefined) {
      return { sources: [], truncated: false, content: undefined }
    }

    // 从回答中提取引用的来源 URL 作为 sources(回答全文为 content)。
    const sources: WebSearchSource[] = []
    const seen = new Set<string>()
    for (const line of resultText.split(/\r?\n/)) {
      const urls = line.match(URL_RE) ?? []
      for (const url of urls) {
        if (seen.has(url)) continue
        seen.add(url)
        const title = titleOf(line, url)
        sources.push({ url, ...(title !== undefined ? { title } : {}) })
      }
    }

    return {
      sources,
      truncated: false,
      content: resultText,
    }
  }

  /** 跑一次 AGY print 调用,返回 result.response 原文(latin1 还原),失败返回 undefined。 */
  private async runAgy(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    const proc = spawn(this.options.command, [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--print-timeout', '60m',
      '--model', this.options.model,
      '--effort', this.options.effort,
      '--dangerously-skip-permissions',
    ], {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
      env: this.options.proxy
        ? { ...process.env, HTTPS_PROXY: this.options.proxy, HTTP_PROXY: this.options.proxy, ALL_PROXY: this.options.proxy }
        : { ...process.env },
    })

    // 无输出兜底:AGY 卡死时强制结束,避免 search 挂死。
    let timedOut = false
    const killer = setTimeout(() => { timedOut = true; proc.kill() }, 60_000)

    let response: string | undefined
    let resultError: string | undefined
    try {
      proc.stdout?.setEncoding('latin1')
      const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity })
      for await (const line of rl) {
        if (signal?.aborted) { proc.kill(); break }
        if (timedOut) break
        if (!line.trim().startsWith('{')) continue
        try {
          const evt = JSON.parse(line)
          if (evt.event === 'result') {
            const r = evt.result
            if (r?.status === 'SUCCESS' && typeof r.response === 'string' && r.response.length > 0) {
              response = Buffer.from(r.response, 'latin1').toString('utf8')
            } else if (r?.status === 'ERROR' && typeof r.error === 'string') {
              resultError = Buffer.from(r.error, 'latin1').toString('utf8')
            }
          }
        } catch { /* 非 JSON 行跳过 */ }
      }
    } finally {
      clearTimeout(killer)
      try { proc.kill() } catch { /* 已退出 */ }
    }
    if (resultError !== undefined) {
      throw new Error(`agy search failed: ${resultError.slice(0, 300)}`)
    }
    return response
  }
}
