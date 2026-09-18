/**
 * translate 单元测试:AGY stream-json 事件 → StreamChunk 翻译。
 * 重点覆盖 result 终局事件的成功/失败/流中断收尾判定。
 */
import { describe, expect, it } from 'vitest'
import { AgyTranslator, parseAgyLine } from '../src/translate.ts'

describe('parseAgyLine result 终局判定', () => {
  it('SUCCESS + response 视为成功并缓存完整文本', () => {
    const parsed = parseAgyLine(JSON.stringify({
      event: 'result',
      result: { status: 'SUCCESS', response: '完成。' },
    }))
    expect(parsed).toEqual({ finalText: '完成。', final: true })
  })

  it('无 status 但带 response 也视为成功(不依赖 status 字段)', () => {
    const parsed = parseAgyLine(JSON.stringify({
      event: 'result',
      result: { response: '完成。' },
    }))
    expect(parsed).toEqual({ finalText: '完成。', final: true })
  })

  it('流中断收尾提示(The stream was interrupted)不算执行失败', () => {
    const parsed = parseAgyLine(JSON.stringify({
      event: 'result',
      result: { error: 'The stream was interrupted. Please continue the task you were working on.' },
    }))
    expect(parsed).toEqual({ final: true })
  })

  it('普通错误 result 仍判定为执行失败', () => {
    const parsed = parseAgyLine(JSON.stringify({
      event: 'result',
      result: { status: 'ERROR', error: 'rate limit exceeded' },
    }))
    expect(parsed).toEqual({ final: true, resultError: 'rate limit exceeded' })
  })
})

describe('conversation_id 解析(真实事件形状)', () => {
  it('init:conversation_id 在事件顶层(2026-09-18 实测 dump),嵌套旧形状仍兼容', () => {
    // 现场:旧解析取 init.conversation_id 恒 undefined——--conversation 从未
    // 生效,每次调用都新建会话全量重发(历史 1.2MB)。
    expect(parseAgyLine(JSON.stringify({
      event: 'init',
      conversation_id: 'c-real',
      init: { model: 'm', cwd: 'D:/x', tools: ['run_command'] },
    }))).toEqual({ conversationId: 'c-real' })
    expect(parseAgyLine(JSON.stringify({
      event: 'init',
      init: { conversation_id: 'c-nested' },
    }))).toEqual({ conversationId: 'c-nested' })
  })

  it('step_update 带 conversation_id 时不丢 delta/usage(兜底来源)', () => {
    const parsed = parseAgyLine(JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: 'c1', step_type: 'agent_response', state: 'ACTIVE', text_delta: 'hello' },
    }))
    expect(parsed?.conversationId).toBe('c1')
    expect(parsed?.delta).toBe('hello')
  })

  it('result 带 conversation_id 时随终局一并返回(最后兜底)', () => {
    const parsed = parseAgyLine(JSON.stringify({
      event: 'result',
      result: { status: 'SUCCESS', response: 'ok', conversation_id: 'c1' },
    }))
    expect(parsed).toEqual({ finalText: 'ok', final: true, conversationId: 'c1' })
  })
})

describe('AgyTranslator.push:conversation_id 不截断本行处理', () => {
  it('step_update 带 conversation_id 时 delta 与 conversationId 同时产出', () => {
    const t = new AgyTranslator()
    const r = t.push(JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: 'c1', step_type: 'agent_response', state: 'ACTIVE', text_delta: 'hi' },
    }))
    expect(r.conversationId).toBe('c1')
    expect(r.chunks.some(c => c.type === 'text-delta')).toBe(true)
  })

  it('init 顶层 conversation_id 随 push 返回', () => {
    const t = new AgyTranslator()
    const r = t.push(JSON.stringify({ event: 'init', conversation_id: 'c1', init: { model: 'm' } }))
    expect(r.conversationId).toBe('c1')
  })
})

describe('AgyTranslator 终局收尾', () => {
  it('流中断提示后 end() 产出正常 finish,不报执行失败', () => {
    const t = new AgyTranslator()
    // 任务文本已通过 step_update 流式输出
    t.push(JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'agent_response', text_delta: '任务完成。' },
    }))
    // 收尾 result 携带流中断提示
    const pushResult = t.push(JSON.stringify({
      event: 'result',
      result: { error: 'The stream was interrupted. Please continue the task you were working on.' },
    }))
    expect(pushResult.final).toBe(true)
    expect(t.resultError).toBeUndefined()
    const chunks = t.end()
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish?.type === 'finish' && finish.reason.kind).toBe('stop')
  })

  it('真失败 result 在 end() 产出执行失败 finish', () => {
    const t = new AgyTranslator()
    t.push(JSON.stringify({
      event: 'result',
      result: { status: 'ERROR', error: 'tool failed' },
    }))
    expect(t.resultError).toBe('tool failed')
    const chunks = t.end()
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish?.type === 'finish' && finish.reason.kind).toBe('error')
  })
})
