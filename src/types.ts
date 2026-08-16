/**
 * AGY(Antigravity CLI)stream-json wire 类型。
 * @module llm-agy/types
 */

/** AGY 单步 usage(分步报告,非累计)。 */
export interface AgyUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  reasoningTokens?: number
}

/** AGY step_update 里的一步。 */
export interface AgyStep {
  /** step_type:user_input / agent_response / tool / checkpoint / error_message / unknown。 */
  stepType?: string
  /** 步骤状态:ACTIVE / DONE / ERROR。 */
  state?: string
  /** 步骤序号(同一工具的 ACTIVE/DONE 配对用)。 */
  stepIndex?: number
  /** 工具名(step_type=tool 时)。 */
  toolName?: string
  /** 工具参数(step_type=tool 时)。 */
  toolParams?: Record<string, unknown>
  /** 工具输出(step_type=tool 且 DONE 时)。 */
  output?: unknown
}

/** 解析后的 AGY 一行事件。 */
export interface AgyLine {
  /** init 事件的会话 id(用于 --conversation 恢复重试)。 */
  conversationId?: string
  /** 文本增量(agent_response 的 text_delta)。 */
  delta?: string
  /** 本步 usage。 */
  usage?: AgyUsage
  /** 工具/步骤事件。 */
  step?: AgyStep
  /** result 事件 status=SUCCESS 时的完整最终文本(无截断损坏)。 */
  finalText?: string
  /** result 事件 status=ERROR 时的执行错误。 */
  resultError?: string
}

/** AGY result 事件。 */
export interface AgyResult {
  status?: string
  response?: unknown
  error?: unknown
}

/** AGY stream-json 完整事件形状。 */
export interface AgyEvent {
  event?: string
  conversation_id?: string
  init?: { conversation_id?: string; cwd?: string; model?: string }
  step_update?: {
    text_delta?: unknown
    usage?: { input_tokens?: unknown; output_tokens?: unknown; cache_read_tokens?: unknown; thinking_tokens?: unknown }
    step_type?: unknown
    state?: unknown
    step_index?: unknown
    tool_name?: unknown
    tool_info?: { name?: unknown; parameters?: unknown; output?: unknown }
  }
  result?: AgyResult
}
