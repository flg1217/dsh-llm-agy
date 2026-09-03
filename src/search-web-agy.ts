/**
 * `search_web_agy` 工具:AGY 驱动的深度网络搜索,独立命名、独立注册。
 *
 * 与系统自带 `web_search` 的关系:系统工具的协作式超时预算只有 60 秒
 * (tool-web 配置在 dsh 源码里,改它无法随插件分发),而 AGY 深度调研
 * 必然超过 60 秒。因此本插件提供自己的搜索工具:
 *
 * - **不设 `timeoutMs`**:timeout-policy 对没有超时预算的工具直接放行,
 *   60 秒硬限制不复存在;
 * - **超时完全自主**:由 AGY provider 的公共执行器控制
 *   (空闲 3 分钟,不设总时长,见 agy-run.ts),AGY 持续输出就续命;
 * - **行为对齐**:queries 参数与系统 web_search 一致(多查询合并为一次
 *   AGY 深度搜索),返回结构相同(内容 + sources + truncated)。
 *
 * 同时注入 systemPrompt 引导,告诉模型网络调研用本工具而非 web_search。
 * @module llm-agy/search-web-agy
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgySearchProvider } from './search.js'

/** 引导文本:与官方 tool:web_search section(order 110)同时存在时,靠语气把模型拉过来。 */
const GUIDE_TEXT = `Use the search_web_agy tool for ANY current or web research (news, docs, prices, reviews, code changes). ` +
  `It drives AGY deep research: it searches, opens and reads the full source pages, then synthesizes a comprehensive, cited answer. ` +
  `Unlike web_search it has no short timeout budget, so long multi-page research works reliably. ` +
  `Pass 1-3 queries in the queries array; the tool merges them into one research session.`

/**
 * 注册 search_web_agy 工具(全局常驻),返回注销函数。
 * @param ctx - 插件上下文(tools / systemPrompt 在 inject 中)。
 * @param getProvider - 取当前 AGY 搜索 provider(每次调用时求值,设置面板改动即时生效)。
 */
export function registerSearchWebAgy(ctx: Context, getProvider: () => AgySearchProvider): (() => void) | undefined {
  try {
    const offTool = ctx.tools.register(defineTool({
      name: 'search_web_agy',
      description:
        'Search the web with AGY deep research: auto-search, read full sources, and return a comprehensive cited answer. '
        + 'Recommended over web_search for any current-information task — it has no short timeout budget, '
        + 'so long research sessions work reliably. Queries: 1-3 strings in the required array.',
      parameters: {
        queries: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'Required search queries; 1-3 items, merged into one AGY research session.',
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
                  snippet: { type: 'string' },
                  publishedAt: { type: 'string' },
                },
              },
            },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.content !== undefined && String(value.content).length > 0
            ? String(value.content)
            : (value.sources ?? []).map((s: { url?: string }) => s.url ?? '').join('\n'),
        }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const raw = args.queries
        const queries = Array.isArray(raw)
          ? raw.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
          : []
        if (queries.length === 0) {
          throw new Error('search_web_agy: queries must be a non-empty string array')
        }
        // 多查询合并为一次 AGY 深度搜索(一次 agent 会话即可综合多个主题)。
        const provider = getProvider()
        const result = await provider.search({ query: queries.join('; ') })
        return {
          ...result.content !== undefined ? { content: result.content } : {},
          sources: result.sources.map((source) => ({
            url: source.url,
            ...source.title !== undefined ? { title: source.title } : {},
            ...source.snippet !== undefined ? { snippet: source.snippet } : {},
            ...source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {},
          })),
          truncated: result.truncated,
        }
      },
    }))
    const offGuide = ctx.systemPrompt?.section?.({
      name: 'tool:search_web_agy',
      order: 111,
      text: GUIDE_TEXT,
    }) ?? (() => {})
    return () => {
      offTool()
      offGuide()
    }
  } catch {
    /* 注册失败(如已存在同名工具)则跳过 */
    return undefined
  }
}
