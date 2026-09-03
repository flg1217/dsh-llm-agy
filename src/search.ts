/**
 * AGY 搜索 provider:`search_web_agy` 工具的执行后端。
 *
 * - available() 只做本地可用性检查(不联网);
 * - search() 经公共执行器跑一次 AGY 深度调研,解析 result.response 提取 sources。
 *
 * 限制(实测):
 * - AGY 的 search_web 不通过 stream-json 暴露结构化结果(tool_info.output 为空),
 *   只有 result.response 里是模型总结后的文本,需正则提取 URL/标题;
 * - 返回的 URL 是 Google Vertex AI grounding 重定向链接(可点击,非原始 URL);
 * - 每次搜索 = 一次完整 AGY 调用(约 34K input tokens / 5-10 秒)。
 * @module llm-agy/search
 */

import { spawnSync } from 'node:child_process'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { runAgyText } from './agy-run.js'

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
  /**
   * 超时预算(可选)。生产用执行器默认(空闲 3 分钟 / 总 15 分钟);
   * 测试注入小值以便压缩时间。
   */
  timeouts?: { idleMs?: number; totalMs?: number }
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

    const resultText = await runAgyText({
      command: this.options.command,
      prompt,
      proxy: this.options.proxy,
      model: this.options.model,
      effort: this.options.effort,
      signal,
      timeouts: this.options.timeouts,
    })

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
}
