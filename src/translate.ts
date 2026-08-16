/**
 * 翻译模块:把 AGY stream-json 事件翻译为 harness StreamChunk 流。
 * 对齐 llm-deepseek/translate.ts 的模式:
 * - 文本块在首个 delta 时打开,后续 delta 持续追加,block-end 延迟到流结束;
 * - usage 按 dsh 的 disjoint 约定(cache 从 input 扣除,reasoning 单独计数);
 * - finish 最后产出;AGY 偶发执行失败携带错误,由调用方决定重试。
 * @module llm-agy/translate
 */

import { CallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AgyEvent, AgyLine, AgyStep, AgyUsage } from './types.js'

/** AGY usage → dsh TokenUsage。
 * AGY 的 input_tokens/output_tokens/thinking_tokens 是分步增量(累计后等于
 * result 全量),且 input_tokens 本身不含缓存;cache_read_tokens 是累计值。
 * 因此直接映射即为 disjoint 约定,不要再从 inputTokens 扣减 cache
 * (否则 input < cache 时产生负数,持久化 schema 校验会失败)。
 */
export function mapAgyUsage(u: AgyUsage): TokenUsage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    ...u.cacheReadTokens !== undefined && u.cacheReadTokens > 0 ? { cacheReadTokens: u.cacheReadTokens } : {},
    ...u.reasoningTokens !== undefined ? { reasoningTokens: u.reasoningTokens } : {},
  }
}

/** 解析 AGY stream-json 一行。 */
export function parseAgyLine(line: string): AgyLine | undefined {
  if (!line.trim().startsWith('{')) return undefined
  try {
    const evt = JSON.parse(line) as {
      event?: string
      init?: { conversation_id?: string }
      step_update?: AgyEvent['step_update']
      result?: { status?: string; response?: unknown; error?: unknown }
    }
    // init 事件:提供 conversation_id,重试时用 --conversation 恢复同一会话续跑。
    if (evt.event === 'init') {
      const cid = evt.init?.conversation_id
      return typeof cid === 'string' && cid.length > 0 ? { conversationId: cid } : undefined
    }
    const su = evt.step_update
    if (su !== undefined) {
      const out: AgyLine = {}
      const delta = su.text_delta
      if (typeof delta === 'string' && delta.length > 0) out.delta = delta
      const it = su.usage?.input_tokens
      const ot = su.usage?.output_tokens
      if (typeof it === 'number' && typeof ot === 'number') {
        const cache = su.usage?.cache_read_tokens
        const thinking = su.usage?.thinking_tokens
        out.usage = {
          inputTokens: it,
          outputTokens: ot,
          ...typeof cache === 'number' && cache > 0 ? { cacheReadTokens: cache } : {},
          ...typeof thinking === 'number' && thinking > 0 ? { reasoningTokens: thinking } : {},
        }
      }
      const stepType = su.step_type
      if (typeof stepType === 'string') {
        const step: AgyStep = {
          stepType,
          ...typeof su.state === 'string' ? { state: su.state } : {},
          ...typeof su.step_index === 'number' ? { stepIndex: su.step_index } : {},
        }
        if (stepType === 'tool') {
          step.toolName = typeof su.tool_name === 'string' ? su.tool_name : undefined
          const info = su.tool_info
          if (info?.parameters !== undefined && typeof info.parameters === 'object') {
            step.toolParams = info.parameters as Record<string, unknown>
          }
          if (info?.output !== undefined) step.output = info.output
        }
        out.step = step
      }
      return out
    }
    // result 事件:AGY 流式 text_delta 会在切分处产生 U+FFFD,而 result.response
    // 是完整无损坏的最终文本。作为 finalText 缓存,在 end() 时覆盖流式拼接结果;
    // 不直接输出为 delta,避免与已流式输出的内容重复。
    if (evt.event === 'result') {
      const r = evt.result
      if (r?.status === 'SUCCESS') {
        const response = r.response
        if (typeof response === 'string' && response.length > 0) return { finalText: response }
        return {}
      }
      return {
        ...typeof r?.error === 'string' && r.error.length > 0 ? { resultError: r.error } : {},
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * AGY → StreamChunk 翻译状态机。
 * 调用方逐行 push,收集返回的 chunks 与工具步骤;流结束后调用 end() 收尾。
 */
export class AgyTranslator {
  private nextIndexValue = 0
  private textOpen = false
  private _text = ''
  private _usage: TokenUsage | undefined
  private _resultError: string | undefined
  /** 单次请求的 input_tokens(最后一次 usage 步),用于判断单次请求是否超限。 */
  private _lastInputTokens = 0
  /** result.response 的完整最终文本(无 U+FFFD 截断损坏),end() 时覆盖流式拼接。 */
  private _finalText: string | undefined
  /** 最近执行步骤(工具名+参数摘要+结果),供反馈块呈现异常发生的位置。 */
  readonly recentSteps: { toolName: string; args: string; status: string; message?: string }[] = []
  // 流式 UTF-8 还原:AGY 输出按字节切分,且经 latin1 读取保留原始字节;
  // TextDecoder 流式跨事件恢复被切分的多字节字符。
  private readonly utf8 = new TextDecoder()

  /**
   * 处理一行 AGY 输出。
   * @returns 本行产生的 StreamChunk(文本流,实时)与工具步骤(由调用方落地为会话事件)。
   */
  push(line: string): { chunks: StreamChunk[]; step?: AgyStep; conversationId?: string } {
    const chunks: StreamChunk[] = []
    const parsed = parseAgyLine(line)
    if (parsed === undefined) return { chunks }

    if (parsed.conversationId !== undefined) return { chunks, conversationId: parsed.conversationId }

    if (parsed.usage !== undefined) {
      // AGY 分步报告 usage:input/output/thinking 是增量(累计),
      // cache_read 是累计值(取最大值,不能累加)。
      const m = mapAgyUsage(parsed.usage)
      this._usage = {
        inputTokens: (this._usage?.inputTokens ?? 0) + m.inputTokens,
        outputTokens: (this._usage?.outputTokens ?? 0) + m.outputTokens,
        cacheReadTokens: Math.max(this._usage?.cacheReadTokens ?? 0, m.cacheReadTokens ?? 0),
        reasoningTokens: (this._usage?.reasoningTokens ?? 0) + (m.reasoningTokens ?? 0),
      }
      // 最后一步的 input_tokens(单次请求大小,用于判断"是否真要超限")。
      this._lastInputTokens = m.inputTokens
    }
    if (parsed.resultError !== undefined) this._resultError = parsed.resultError
    if (parsed.finalText !== undefined) {
      // result.response 与 text_delta 一样经 latin1 读取,字节需还原为 UTF-8。
      this._finalText = Buffer.from(parsed.finalText, 'latin1').toString('utf8')
    }

    if (parsed.delta !== undefined) {
      // 过滤 AGY 的系统状态标记(如 AGY_REUSE_READY / AGY_REUSED_OK),
      // 它们是复用会话时输出到 stdout 的状态行,不是模型回答。
      if (!/^AGY_[A-Z0-9_]+/.test(parsed.delta.trim())) {
        // latin1 字符 → 原始字节 → 流式 UTF-8 解码,恢复被切分的多字节字符。
        const decoded = this.utf8.decode(Buffer.from(parsed.delta, 'latin1'), { stream: true })
        if (decoded.length > 0) {
          if (!this.textOpen) {
            this.textOpen = true
            this.nextIndexValue += 1
            chunks.push({ type: 'block-start', index: this.nextIndexValue, blockType: 'text' })
          }
          // AGY 一次给整段;拆小块输出,界面产生实时流式效果。
          const CHUNK = 40
          for (let i = 0; i < decoded.length; i += CHUNK) {
            const part = decoded.slice(i, i + CHUNK)
            chunks.push({ type: 'text-delta', index: this.nextIndexValue, text: part })
            this._text += part
          }
        }
      }
    }

    return { chunks, ...parsed.step !== undefined ? { step: parsed.step } : {} }
  }
  /** 冲刷解码器残余字节(AGY 最后一段文本的尾字符可能被截断)。 */
  flush(): StreamChunk[] {
    const tail = this.utf8.decode()
    if (tail.length === 0) return []
    const chunks: StreamChunk[] = []
    if (!this.textOpen) {
      this.textOpen = true
      this.nextIndexValue += 1
      chunks.push({ type: 'block-start', index: this.nextIndexValue, blockType: 'text' })
    }
    const CHUNK = 40
    for (let i = 0; i < tail.length; i += CHUNK) {
      const part = tail.slice(i, i + CHUNK)
      chunks.push({ type: 'text-delta', index: this.nextIndexValue, text: part })
      this._text += part
    }
    return chunks
  }

  /** 流结束:关闭文本块、产出 usage 与 finish。 */
  end(): StreamChunk[] {
    const chunks: StreamChunk[] = []
    // 优先用 result.response(完整、无截断损坏);AGY 流式 text_delta 会在切分
    // 边界把多字节字符替换成 U+FFFD,流式拼接文本不如最终响应可靠。
    let finalText = this._finalText ?? this._text
    // 执行失败(result ERROR)时没有 response,只能用流式拼接文本;
    // 其中残留的 U+FFFD 是 AGY 字节截断的产物,不可恢复,直接剔除
    // 避免把乱码字符原样呈现给用户。
    if (this._resultError !== undefined) {
      finalText = finalText.replace(/\uFFFD/g, '')
    }
    if (this.textOpen) {
      this.textOpen = false
      chunks.push({ type: 'block-end', index: this.nextIndexValue, block: { type: 'text', text: finalText } })
    }
    if (this._usage !== undefined) chunks.push({ type: 'usage', usage: this._usage })
    if (this._resultError !== undefined) {
      chunks.push({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: `agy 执行失败: ${this._resultError}`, code: 'AGY_EXEC_ERROR' },
        },
      })
    } else {
      chunks.push({ type: 'finish', reason: { kind: 'stop' } })
    }
    return chunks
  }

  /** 已收到的执行错误(AGY result ERROR)。 */
  get resultError(): string | undefined {
    return this._resultError
  }

  /** 下一个可用 block index(adapter 附加反馈块时使用)。 */
  get nextIndex(): number {
    return this.nextIndexValue
  }

  /** 累计输入 token(含缓存)。AGY 的 input_tokens 是增量,cacheRead 是累计值。 */
  get totalInputTokens(): number {
    return (this._usage?.inputTokens ?? 0) + (this._usage?.cacheReadTokens ?? 0)
  }

  /**
   * 单次请求的 input_tokens(最近一次有 usage 的步)。
   * 累计的 totalInputTokens 不代表单次请求大小,不能用它判断"上下文爆了"。
   */
  get lastInputTokens(): number {
    return this._lastInputTokens
  }
}

/** 生成工具卡片用的 callId。
 * 同一 step_index 的 ACTIVE/DONE 配对;attempt 区分重试执行——重试恢复
 * AGY 会话后 step_index 会重复出现,不加 attempt 会产生重复 callId,
 * 导致会话轨迹构建报 "more than one start Match"。
 */
export function agyCallId(toolName: string, stepIndex: number | undefined, attempt = 1): CallId {
  return CallId(`agy-${attempt}-${toolName}-${stepIndex ?? Math.random()}`)
}
