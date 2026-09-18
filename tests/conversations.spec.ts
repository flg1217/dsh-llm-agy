/**
 * ConversationStore 测试(agy 版):落盘/重载、损坏容错、最久未使用逐出。
 *
 * 现场(2026-09-18):续接记录曾只存内存 Map,服务重启即丢——对已有会话的
 * 首次续跑退化成全量重发(历史 1.2MB,AGY 每次先读巨型 agy-task 文件)。
 * 本 store 让 conversationId 与发送锚点跨重启存活。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConversationStore } from '../src/conversations.ts'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'agy-store-')), 'conversations.json')
}

describe('ConversationStore(agy)', () => {
  it('写入后可重载(跨重启恢复)——含补发主锚 lastSentMessageId', async () => {
    const file = tempFile()
    const store = new ConversationStore(file)
    store.set('session-a', { conversationId: 'c-1', sentCount: 7, lastSentMessageId: 'msg-42' })
    await new Promise(resolve => setTimeout(resolve, 700))
    const reloaded = new ConversationStore(file)
    // 主锚漏恢复会让重启后的补发退回数量锚(压缩/编辑后不可靠)。
    expect(reloaded.get('session-a'))
      .toMatchObject({ conversationId: 'c-1', sentCount: 7, lastSentMessageId: 'msg-42' })
  })

  it('文件损坏时从空开始,不抛错', () => {
    const file = tempFile()
    writeFileSync(file, 'not json{{{')
    const store = new ConversationStore(file)
    expect(store.get('anything')).toBeUndefined()
    store.set('s', { conversationId: 'c', sentCount: 0 })
    expect(store.get('s')?.conversationId).toBe('c')
  })

  it('超过上限时逐出最久未使用', async () => {
    const file = tempFile()
    const store = new ConversationStore(file)
    store.set('oldest', { conversationId: 'x', sentCount: 0 })
    await new Promise(resolve => setTimeout(resolve, 5))
    for (let i = 0; i < 2100; i++) store.set(`s-${String(i)}`, { conversationId: `c-${String(i)}`, sentCount: i })
    expect(store.get('oldest')).toBeUndefined()
    expect(store.get('s-2099')?.conversationId).toBe('c-2099')
  })

  it('delete 后不再返回', () => {
    const store = new ConversationStore(null)
    store.set('s', { conversationId: 'c', sentCount: 1 })
    expect(store.get('s')).toBeDefined()
    store.delete('s')
    expect(store.get('s')).toBeUndefined()
  })

  it('落盘格式为 JSON 对象(键 = dsh 会话 id),坏记录条目被跳过', async () => {
    const file = tempFile()
    const store = new ConversationStore(file)
    store.set('dsh-1', { conversationId: 'c-9', sentCount: 3 })
    await new Promise(resolve => setTimeout(resolve, 700))
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(parsed['dsh-1']).toMatchObject({ conversationId: 'c-9', sentCount: 3 })

    // 混入坏记录(缺 conversationId):重载时跳过,不污染其余条目。
    writeFileSync(file, JSON.stringify({
      'dsh-1': { conversationId: 'c-9', sentCount: 3, at: 1 },
      'dsh-bad': { sentCount: 5 },
    }))
    const reloaded = new ConversationStore(file)
    expect(reloaded.get('dsh-1')?.conversationId).toBe('c-9')
    expect(reloaded.get('dsh-bad')).toBeUndefined()
  })
})
