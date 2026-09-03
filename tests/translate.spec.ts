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
