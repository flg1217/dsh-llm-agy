/**
 * 接管开关的接管动作测试:开关必须真的把全局 web 搜索的选择与预算改到位。
 *
 * 锁死的行为:
 * - 开启:web 行 searchProvider → agy;tool-web 行 searchTimeoutMs 抬到
 *   AGY_SEARCH_TIMEOUT_MS(已是更大值则不动);
 * - 关闭:web 行还原为继承值;tool-web 行只回收本插件设的那一档,用户手写的
 *   更大值原样保留;
 * - 已是目标值时零写入(否则每次启动都会白写一次配置并触发一次条目重载);
 * - 服务缺失 / 条目缺失不抛异常,只返回空改动。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  AGY_SEARCH_TIMEOUT_MS,
  applySearchTakeover,
  providerSelectionEditor,
  type ProviderSelectionEditor,
} from '../src/provider-selection.ts'

interface Row {
  id: string
  config: Record<string, unknown>
  inherited: Record<string, unknown>
}

/** 记录每次 edit 的目标配置的假 configEditor。 */
function fakeEditor(rows: Row[]): {
  editor: ProviderSelectionEditor
  edits: Array<{ id: string; next: Record<string, unknown> }>
} {
  const edits: Array<{ id: string; next: Record<string, unknown> }> = []
  const editor: ProviderSelectionEditor = {
    configuration: () => rows.map(row => ({
      entry: { options: { id: row.id, config: { ...row.config } } },
      inherited: { ...row.inherited },
      override: {},
    })),
    edit: async (entry, change) => {
      const row = rows.find(candidate => candidate.id === entry.options.id)
      if (row === undefined) throw new Error(`unknown entry ${entry.options.id}`)
      const next = change({ ...row.config }, { ...row.inherited })
      edits.push({ id: row.id, next })
      row.config = next
    },
  }
  return { editor, edits }
}

/** base bundle 的 web / tool-web 两行,外加一个未接管的旁观条目。 */
function baseRows(): Row[] {
  return [
    { id: 'web', config: { searchProvider: 'deepseek-official', fetchProvider: 'http' }, inherited: { searchProvider: 'deepseek-official', fetchProvider: 'http' } },
    { id: 'tool-web', config: { fetch: true, searchTimeoutMs: 60_000 }, inherited: { fetch: true, searchTimeoutMs: 60_000 } },
    { id: 'unrelated', config: { keep: 1 }, inherited: { keep: 1 } },
  ]
}

describe('applySearchTakeover', () => {
  it('开启时改写 web 选择与 tool-web 预算', async () => {
    const { editor, edits } = fakeEditor(baseRows())
    expect(await applySearchTakeover(editor, true)).toEqual(['web', 'tool-web'])
    expect(edits).toEqual([
      { id: 'web', next: { searchProvider: 'agy', fetchProvider: 'http' } },
      { id: 'tool-web', next: { fetch: true, searchTimeoutMs: AGY_SEARCH_TIMEOUT_MS } },
    ])
  })

  it('开启时保留用户已配的更大预算,不压低', async () => {
    const rows = baseRows()
    rows[1].config.searchTimeoutMs = 600_000
    const { editor, edits } = fakeEditor(rows)
    expect(await applySearchTakeover(editor, true)).toEqual(['web'])
    expect(edits.map(edit => edit.id)).toEqual(['web'])
  })

  it('已是目标值时零写入(避免启动即白写一次配置)', async () => {
    const rows = baseRows()
    rows[0].config.searchProvider = 'agy'
    rows[1].config.searchTimeoutMs = AGY_SEARCH_TIMEOUT_MS
    const { editor, edits } = fakeEditor(rows)
    expect(await applySearchTakeover(editor, true)).toEqual([])
    expect(edits).toEqual([])
  })

  it('关闭时还原选择,并只回收本插件设的那一档预算', async () => {
    const rows = baseRows()
    rows[0].config.searchProvider = 'agy'
    rows[1].config.searchTimeoutMs = AGY_SEARCH_TIMEOUT_MS
    const { editor, edits } = fakeEditor(rows)
    expect(await applySearchTakeover(editor, false)).toEqual(['web', 'tool-web'])
    expect(edits).toEqual([
      { id: 'web', next: { searchProvider: 'deepseek-official', fetchProvider: 'http' } },
      { id: 'tool-web', next: { fetch: true, searchTimeoutMs: 60_000 } },
    ])
  })

  it('关闭时不动用户手写的更大预算', async () => {
    const rows = baseRows()
    rows[0].config.searchProvider = 'agy'
    rows[1].config.searchTimeoutMs = 600_000
    const { editor, edits } = fakeEditor(rows)
    expect(await applySearchTakeover(editor, false)).toEqual(['web'])
    expect(edits).toEqual([
      { id: 'web', next: { searchProvider: 'deepseek-official', fetchProvider: 'http' } },
    ])
  })

  it('继承层没有 searchProvider 时删除该字段而不是写 undefined', async () => {
    const rows: Row[] = [
      { id: 'web', config: { searchProvider: 'agy', fetchProvider: 'http' }, inherited: { fetchProvider: 'http' } },
    ]
    const { editor, edits } = fakeEditor(rows)
    expect(await applySearchTakeover(editor, false)).toEqual(['web'])
    expect(edits[0].next).toEqual({ fetchProvider: 'http' })
    expect(Object.hasOwn(edits[0].next, 'searchProvider')).toBe(false)
  })

  it('服务缺失或条目缺失时不抛异常,返回空改动', async () => {
    expect(await applySearchTakeover(undefined, true)).toEqual([])
    const { editor, edits } = fakeEditor([{ id: 'unrelated', config: {}, inherited: {} }])
    expect(await applySearchTakeover(editor, true)).toEqual([])
    expect(edits).toEqual([])
  })

  it('写入失败向上抛出,交给调用方告警(不吞掉真实故障)', async () => {
    const failure = new Error('Configuration for "web" is overridden by a home patch')
    const editor: ProviderSelectionEditor = {
      configuration: () => [{
        entry: { options: { id: 'web', config: { searchProvider: 'deepseek-official' } } },
        inherited: { searchProvider: 'deepseek-official' },
        override: {},
      }],
      edit: vi.fn().mockRejectedValue(failure),
    }
    await expect(applySearchTakeover(editor, true)).rejects.toThrow(failure)
  })
})

describe('providerSelectionEditor', () => {
  const ctxWith = (service: unknown): Context => ({ get: () => service }) as unknown as Context

  it('缺少 configEditor 时返回 undefined', () => {
    expect(providerSelectionEditor(ctxWith(undefined))).toBeUndefined()
  })

  it('形态不符(缺 edit)时按缺失处理', () => {
    expect(providerSelectionEditor(ctxWith({ configuration: () => [] }))).toBeUndefined()
  })

  it('两个方法齐备时返回该服务', () => {
    const service = { configuration: () => [], edit: async () => {} }
    expect(providerSelectionEditor(ctxWith(service))).toBe(service)
  })
})
