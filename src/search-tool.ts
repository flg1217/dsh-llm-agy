/**
 * AGY 独立搜索工具(agy_web_search):searchOverride 关闭时注册。
 * 不占全局 web 搜索缝(ctx.web),作为独立工具直接调用 AgySearchProvider,
 * 避免与其它搜索 provider(如 web-search-openai)注册进同一缝造成
 * WEB_PROVIDER_AMBIGUOUS 冲突。
 * @module llm-agy/search-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WebSearchResult } from '@deepseek-ai/dsh-web'
import { AgySearchProvider } from './search.js'

/** 单次调用最多查询数(与官方 web_search 一致)。 */
const MAX_QUERIES = 3
/** 返回 sources 上限。 */
const MAX_RESULTS = 5

/** 校验并去重查询:至少 1 条、每条非空。 */
function parseQueries(args: { queries?: unknown }): string[] {
  const raw = args.queries
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUERIES) {
    throw new Error(`queries must contain 1-${MAX_QUERIES} non-empty queries`)
  }
  if (raw.some((q) => typeof q !== 'string' || q.trim().length === 0)) {
    throw new Error('each query must be a non-empty string')
  }
  return [...new Set(raw as string[])]
}

/**
 * 注册 agy_web_search 独立工具(含系统提示 section)。
 * @returns disposer;插件运行时被注销,支持开关热切换。
 */
export function registerAgySearchTool(ctx: Context, options: AgySearchProviderOptions): (() => void) | undefined {
  const provider = new AgySearchProvider(options)
  let disposeTool: (() => void) | undefined
  try {
    disposeTool = ctx.tools.register(defineTool({
      name: 'agy_web_search',
      description:
        'Search the web with AGY (Antigravity CLI) deep search. Provide 1-3 queries in the required queries array; '
        + 'each is searched with the AGY agent which reads the sources and synthesizes a comprehensive answer. '
        + 'Returns an optional answer plus a list of source URLs. Use when the user wants thorough, up-to-date '
        + 'information from the web (independent AGY search, not the global web_search tool).',
      parameters: {
        queries: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: `Required search queries; accepts 1-${MAX_QUERIES} items and merges their results.`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string' },
            sources: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  url: { type: 'string', required: true },
                  title: { type: 'string' },
                },
              },
            },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: [
            ...(value.content !== undefined && value.content.length > 0 ? [value.content] : []),
            value.sources.length > 0
              ? `Sources:\n${value.sources.map((s: { url: string; title?: string }) => `- [${s.title ?? s.url}](${s.url})`).join('\n')}`
              : 'No results found.',
            'Cite the relevant URLs above as markdown links in your answer.',
          ].join('\n\n'),
        }],
      },
      // 搜索不修改父代理状态,可并发。
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const queries = parseQueries(args)
        // 单查询直接搜;多查询并发跑,失败即抛。
        if (queries.length === 1) {
          return toValue(await provider.search({ query: queries[0] as string, maxResults: MAX_RESULTS }, exec.signal))
        }
        const results = await Promise.all(
          queries.map((query) => provider.search({ query, maxResults: MAX_RESULTS }, exec.signal)),
        )
        return toValue(mergeResults(queries, results))
      },
    }))
  } catch {
    // 注册失败(工具重名等)不阻断插件其余功能。
    return undefined
  }

  let disposeSection: (() => void) | undefined
  try {
    disposeSection = ctx.systemPrompt.section({
      name: 'tool:agy_web_search',
      order: 111,
      text: context => ctx.tools.get('agy_web_search', context.scope) === undefined
        ? ''
        : `Use the agy_web_search tool when the user needs thorough current web information or when the global `
          + `web_search tool is unavailable: it searches with the AGY (Antigravity CLI) agent, reads the sources, `
          + `and synthesizes a comprehensive cited answer. The required queries array accepts 1-${MAX_QUERIES} `
          + `non-empty queries; use a one-item array for a single search. Cite the returned source URLs as `
          + `markdown links in your answer.`,
    })
  } catch {
    // section 注册失败不影响工具本身。
    disposeSection = undefined
  }

  return () => {
    try { disposeTool?.() } catch { /* 注销失败忽略 */ }
    try { disposeSection?.() } catch { /* 注销失败忽略 */ }
  }
}

/** AgySearchProvider 构造参数(与 search.ts 的 AgySearchOptions 同构)。 */
export interface AgySearchProviderOptions {
  command: string
  model: string
  effort: string
  proxy?: string
}

/** 工具返回值(与官方 web_search 同形)。 */
interface SearchToolValue {
  content?: string
  sources: { url: string; title?: string }[]
  truncated: boolean
}

/** 把一次搜索结果投影为工具返回值。 */
function toValue(result: WebSearchResult): SearchToolValue {
  return {
    ...result.content !== undefined ? { content: result.content } : {},
    sources: result.sources.map((s) => ({ url: s.url, ...(s.title !== undefined ? { title: s.title } : {}) })),
    truncated: result.truncated,
  }
}

/** 多查询结果合并:去重、轮询排列、截断。 */
function mergeResults(queries: string[], results: WebSearchResult[]): WebSearchResult {
  const seen = new Set<string>()
  const sources: { url: string; title?: string }[] = []
  const maxRank = Math.max(...results.map((r) => r.sources.length), 0)
  let dropped = false
  for (let rank = 0; rank < maxRank; rank++) {
    for (const result of results) {
      const source = result.sources[rank]
      if (source !== undefined && !seen.has(source.url)) {
        seen.add(source.url)
        if (sources.length === MAX_RESULTS) { dropped = true; break }
        sources.push(source)
      }
    }
    if (dropped) break
  }
  const contents = results.flatMap((result, index) =>
    result.content === undefined || result.content.length === 0 ? [] : [`### ${queries[index]}\n\n${result.content}`])
  return {
    ...contents.length > 0 ? { content: contents.join('\n\n') } : {},
    sources,
    truncated: dropped || results.some((r) => r.truncated),
  }
}
