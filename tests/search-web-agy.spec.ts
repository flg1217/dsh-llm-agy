/**
 * search_web_agy 工具单元测试:
 * - 注册独立命名的 search_web_agy(不碰系统 web_search);
 * - execute 走 AGY provider,queries 合并为一次深度搜索;
 * - 不设工具级 timeoutMs(timeout-policy 对无预算工具放行,超时全归执行器);
 * - 注入 systemPrompt 引导模型用它做网络调研。
 */
import { describe, expect, it, vi } from 'vitest'
import { registerSearchWebAgy } from '../src/search-web-agy.ts'

interface ToolDef {
  readonly name?: string
  readonly timeoutMs?: number
  readonly execute?: (args: Record<string, unknown>) => Promise<unknown>
}

/** 假 ctx:捕获工具注册与引导 section,注入假 provider。 */
function setup(search: (request: { query: string }) => Promise<unknown>): {
  tool: ToolDef | undefined
  section: Record<string, unknown> | undefined
  provider: { search: ReturnType<typeof vi.fn> }
} {
  let tool: ToolDef | undefined
  let section: Record<string, unknown> | undefined
  const provider = { search: vi.fn(search) }
  const ctx = {
    tools: {
      register: (definition: ToolDef): (() => void) => {
        tool = definition
        return () => {}
      },
    },
    systemPrompt: {
      section: (s: Record<string, unknown>): (() => void) => {
        section = s
        return () => {}
      },
    },
  } as never
  registerSearchWebAgy(ctx as never, () => provider as never)
  return { tool, section, provider }
}

describe('search_web_agy 工具', () => {
  it('注册独立命名的工具,且不设工具级 timeoutMs(不受 60s 预算限制)', () => {
    const { tool } = setup(vi.fn(async () => ({ sources: [], truncated: false })))
    expect(tool?.name).toBe('search_web_agy')
    expect(tool?.timeoutMs).toBeUndefined()
  })

  it('execute 合并多查询为一次 AGY 深度搜索,返回官方同构的结果', async () => {
    const { tool, provider } = setup(vi.fn(async () => ({
      content: '综合结论',
      sources: [{ url: 'https://a.com', title: 'A' }, { url: 'https://b.com' }],
      truncated: false,
    })))
    const result = await tool?.execute?.({ queries: ['主题一', '主题二'] })
    expect(provider.search).toHaveBeenCalledWith({ query: '主题一; 主题二' })
    expect(result).toEqual({
      content: '综合结论',
      sources: [
        { url: 'https://a.com', title: 'A' },
        { url: 'https://b.com' },
      ],
      truncated: false,
    })
  })

  it('空 queries 抛出明确错误', async () => {
    const { tool, provider } = setup(vi.fn())
    await expect(tool?.execute?.({ queries: [] })).rejects.toThrow(/non-empty/)
    expect(provider.search).not.toHaveBeenCalled()
  })

  it('注入 systemPrompt 引导,明确推荐 search_web_agy 做网络调研', () => {
    const { section } = setup(vi.fn(async () => ({ sources: [], truncated: false })))
    expect(section?.name).toBe('tool:search_web_agy')
    expect(String(section?.text)).toContain('search_web_agy')
    expect(String(section?.text)).toContain('no short timeout budget')
  })
})
