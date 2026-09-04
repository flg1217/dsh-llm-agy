/**
 * latin1→UTF-8 还原单元测试:
 * AGY stdout 以 latin1 读入(字节保真),text_delta 走 TextDecoder 流式还原,
 * 而 step_update 的 tool_info.parameters / output 与 result.error 是整段
 * JSON 字符串,必须显式还原,否则工具参数、执行反馈、错误信息全是乱码。
 */
import { describe, expect, it } from 'vitest'
import { fixLatin1Deep, latin1ToUtf8, parseAgyLine } from '../src/translate.ts'

/** 构造"经 latin1 读取"的损坏字符串:UTF-8 字节 → latin1 字符。 */
function damaged(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1')
}

describe('latin1ToUtf8', () => {
  it('损坏字符串被还原为原文', () => {
    const original = '试玩体验反馈报告:战棋 PC 风格新交互'
    expect(latin1ToUtf8(damaged(original))).toBe(original)
  })

  it('已含正常中文(> U+00FF)的字符串原样返回,不被二次破坏', () => {
    const text = '正常中文文本 with ascii'
    expect(latin1ToUtf8(text)).toBe(text)
  })

  it('纯 ASCII 原样返回', () => {
    expect(latin1ToUtf8('run_command {"CommandLine":"pwsh"}')).toBe('run_command {"CommandLine":"pwsh"}')
  })

  it('还原后再次调用是幂等的(保护逻辑防双重处理)', () => {
    const once = latin1ToUtf8(damaged('战斗姿势区'))
    expect(latin1ToUtf8(once)).toBe(once)
  })
})

describe('fixLatin1Deep', () => {
  it('对象与数组内的字符串递归还原', () => {
    const input = {
      Message: damaged('# 试玩体验反馈报告'),
      nested: { Content: damaged('移动常驻:通过') },
      list: [damaged('技能卡'), 42, null],
      ascii: 'plain',
    }
    expect(fixLatin1Deep(input)).toEqual({
      Message: '# 试玩体验反馈报告',
      nested: { Content: '移动常驻:通过' },
      list: ['技能卡', 42, null],
      ascii: 'plain',
    })
  })
})

describe('parseAgyLine 集成:step_update 参数还原', () => {
  // 真实链路:AGY 输出 UTF-8 字节流(stdout 中 damaged 字符以单字节存在)
  // → dsh 以 latin1 读入 = 每字节一个字符,恰为 JSON.stringify(obj) 的形态
  // (obj 内是 damaged 串时,其字符全部 ≤ U+00FF,序列化后原样保留)。
  // 因此直接把 JSON 文本喂给 parseAgyLine 即为"latin1 读取后"的真实输入;
  // 不要用 utf8→latin1 Buffer 往返,那会对 latin1 形态文本造成双重损坏。

  it('tool_info.parameters 中的中文被还原', () => {
    const line = JSON.stringify({
      event: 'step_update',
      step_update: {
        step_type: 'tool',
        state: 'ACTIVE',
        step_index: 3,
        tool_info: { parameters: { Recipient: 'session-abc', Message: damaged('# 试玩体验反馈报告') } },
      },
    })
    const parsed = parseAgyLine(`${line}\n`)
    expect(parsed?.step?.toolParams).toEqual({
      Recipient: 'session-abc',
      Message: '# 试玩体验反馈报告',
    })
  })

  it('result.error 中的中文被还原', () => {
    const line = JSON.stringify({
      event: 'result',
      result: { status: 'ERROR', error: damaged('AGY 调用失败:网络连接超时') },
    })
    const parsed = parseAgyLine(`${line}\n`)
    expect(parsed?.resultError).toBe('AGY 调用失败:网络连接超时')
  })
})
