/**
 * agy_web_search 独立工具测试(此前零覆盖)。
 *
 * 锁死的行为:
 * - queries 校验:1-3 条、非空字符串、去重后执行;
 * - 单查询直搜;多查询并发后合并(轮询排列、按 URL 去重、truncated 传播、
 *   content 带各查询标题);
 * - 渲染:content + Sources 列表;无来源给明确提示;附引用要求;
 * - 工具与 systemPrompt section 成对注册,注销函数可用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }))
vi.mock('../src/search.ts', () => ({
  AgySearchProvider: class {
    search = searchMock
  },
}))

const { registerAgySearchTool } = await import('../src/search-tool.ts')

beforeEach(() => {
  searchMock.mockReset()
})

interface ToolDef {
  readonly name?: string
  readonly timeoutMs?: number
  readonly execute?: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>
  readonly output?: { render?: (args: unknown, value: never) => Array<{ text?: string }> }
}

/** 捕获工具与 section 注册的假 ctx。 */
function setup(): { tool: ToolDef | undefined; section: { name?: string; text?: unknown } | undefined; disposeTools: () => void } {
  let tool: ToolDef | undefined
  let section: { name?: string; text?: unknown } | undefined
  let disposed = false
  const ctx = {
    tools: {
      register: (definition: ToolDef): (() => void) => {
        tool = definition
        return () => { disposed = true }
      },
      get: (): unknown => (disposed ? undefined : tool),
    },
    systemPrompt: {
      section: (s: { name?: string; text?: unknown }): (() => void) => {
        section = s
        return () => {}
      },
    },
  } as unknown as Context
  const dispose = registerAgySearchTool(ctx, { command: 'agy', model: 'm', effort: 'high' }) ?? (() => {})
  return { tool, section, disposeTools: dispose }
}

const exec = { signal: new AbortController().signal }

describe('agy_web_search:查询校验', () => {
  it('空数组 / 超过 3 条 / 非字符串 / 空白 → 明确报错且不发起搜索', async () => {
    const { tool } = setup()
    for (const bad of [[], ['a', 'b', 'c', 'd'], [1], ['  ']]) {
      await expect(tool?.execute?.({ queries: bad }, exec)).rejects.toThrow(/queries|non-empty/)
    }
    expect(searchMock).not.toHaveBeenCalled()
  })

  it('重复查询去重后只搜一次', async () => {
    searchMock.mockResolvedValue({ sources: [], truncated: false })
    const { tool } = setup()
    await tool?.execute?.({ queries: ['同一问', '同一问'] }, exec)
    expect(searchMock).toHaveBeenCalledTimes(1)
  })
})

describe('agy_web_search:执行与合并', () => {
  it('单查询直搜,返回官方同构结果', async () => {
    searchMock.mockResolvedValue({ content: '结论', sources: [{ url: 'https://a.com', title: 'A' }], truncated: false })
    const { tool } = setup()
    const value = await tool?.execute?.({ queries: ['主题'] }, exec)
    expect(searchMock).toHaveBeenCalledWith({ query: '主题', maxResults: 5 }, exec.signal)
    expect(value).toEqual({ content: '结论', sources: [{ url: 'https://a.com', title: 'A' }], truncated: false })
  })

  it('多查询并发后合并:轮询排列、URL 去重、content 带各查询标题', async () => {
    searchMock
      .mockResolvedValueOnce({
        content: '内容1',
        sources: [{ url: 'https://a.com' }, { url: 'https://b.com' }],
        truncated: false,
      })
      .mockResolvedValueOnce({
        content: '内容2',
        sources: [{ url: 'https://c.com' }, { url: 'https://a.com' }],
        truncated: true,
      })
    const { tool } = setup()
    const value = await tool?.execute?.({ queries: ['主题一', '主题二'] }, exec) as {
      content?: string
      sources: Array<{ url: string }>
      truncated: boolean
    }
    expect(searchMock).toHaveBeenCalledTimes(2)
    // 轮询:rank0 取 q1.a、q2.c;rank1 取 q1.b(q2.a 重复跳过)。
    expect(value.sources.map(s => s.url)).toEqual(['https://a.com', 'https://c.com', 'https://b.com'])
    expect(value.truncated).toBe(true)
    expect(value.content).toContain('### 主题一')
    expect(value.content).toContain('### 主题二')
  })

  it('两查询都无内容时 content 缺省,来源仍合并', async () => {
    searchMock
      .mockResolvedValueOnce({ sources: [{ url: 'https://a.com' }], truncated: false })
      .mockResolvedValueOnce({ sources: [], truncated: false })
    const { tool } = setup()
    const value = await tool?.execute?.({ queries: ['q1', 'q2'] }, exec) as { content?: string; sources: unknown[] }
    expect(value.content).toBeUndefined()
    expect(value.sources).toHaveLength(1)
  })
})

describe('agy_web_search:渲染与注册', () => {
  it('渲染:content + Sources 列表 + 引用要求', () => {
    const { tool } = setup()
    const rendered = tool?.output?.render?.(undefined, {
      content: '结论',
      sources: [{ url: 'https://a.com', title: 'A' }],
      truncated: false,
    } as never)
    const text = rendered?.[0]?.text ?? ''
    expect(text).toContain('结论')
    expect(text).toContain('- [A](https://a.com)')
    expect(text).toContain('Cite the relevant URLs')
  })

  it('无来源时渲染明确提示', () => {
    const { tool } = setup()
    const rendered = tool?.output?.render?.(undefined, { sources: [], truncated: false } as never)
    expect(rendered?.[0]?.text).toContain('No results found.')
  })

  it('section 仅在工具可见时输出引导;注销函数可用', () => {
    const { tool, section, disposeTools } = setup()
    expect(tool?.name).toBe('agy_web_search')
    expect(section?.name).toBe('tool:agy_web_search')
    const text = (section?.text as (context: { scope: unknown }) => string)({ scope: undefined })
    expect(text).toContain('agy_web_search')
    expect(() => disposeTools()).not.toThrow()
  })
})
