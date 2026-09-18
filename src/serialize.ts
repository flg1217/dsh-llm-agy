/**
 * 序列化模块:把 dsh 消息翻译为 AGY 单轮 prompt。
 * - 系统提示(可选)、对话消息按顺序拼接为文本;
 * - 图片块落盘为临时文件,在 prompt 中给出本地路径(AGY 自行读取看图);
 * - 超长 prompt 写入临时文件,命令行只给短引用(Windows 命令行 32K 限制);
 * - 续聊补发(`resumeReplayPrompt`):从发送锚点切片,把 AGY conversation
 *   尚未见过的消息补上,同时跳过 AGY 自己产生的轮次(其会话里已有)。
 *   算法与 dsh-subagent-codebuddy 的 dsh↔CodeBuddy 转换模块同源,差异:
 *   AGY 有自己的服务端 conversation 上下文,锚点丢失/压缩时**不整体重发**
 *   (重复内容膨胀且会被当作新任务从头重跑),只用最后一条用户输入兜底。
 * - 运行时约束:AGY 是一次性 print 进程,回合结束即终止,后台任务唤醒
 *   循环不存在——每次 prompt 都显式禁止后台任务。
 * @module llm-agy/serialize
 */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

/** 续跑兜底:仅当没有可补发内容时使用。 */
export const CONTINUE_PROMPT
  = '继续完成之前未完成的任务。基于当前工作区状态继续,不要重复已完成的工作,只报告新做的内容。'

/** mediaType → 临时文件扩展名。 */
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * 长 prompt 转临时文件引用的阈值:AGY stdin 单行实测约 2.5MB 处截断
 * (2568544 bytes),留安全余量。命令行 32K 限制已不相关——持久进程模式下
 * prompt 经 stdin 的 NDJSON 行发送(不再走 -p 参数)。
 */
const FILE_REF_THRESHOLD = 2_000_000

/**
 * 运行时约束:AGY 每次调用都是一个一次性 print 进程,回合结束进程即终止,
 * 交互模式里"后台任务完成后再唤醒继续"的循环不存在。
 *
 * 现场实测(2026-09-18):长命令(run_command 约 10 秒超时)被 harness 自动
 * 转成后台任务后,AGY 只等 5 秒("root agent idle; waiting up to 5s for
 * 1 background task(s)")就结束回合、进程退出并尝试终止后台任务——"已启动,
 * 稍后汇报"= 任务悬空丢失。正确做法:**转后台后用 command_status 轮询直到
 * 任务真正结束,拿到结果才结束回合**——回合不结束,进程不退出,任务就不会丢。
 */
const RUNTIME_CONSTRAINTS = [
  '运行环境约束(必须遵守):',
  '- 你处于非交互一次性调用:你的回合结束后本次调用立即终止,进程退出时未完成的后台任务会被销毁——不存在"后台任务完成后再唤醒你"的机制。',
  '- 长命令可能被本环境自动转为后台任务,这是正常的;但转后台后**必须用任务状态工具(manage_task / command_status)持续轮询直到任务真正结束**(间隔可用等待命令),拿到结果(或确凿失败)后才继续下一步或结束回合。',
  '- 绝对禁止"已启动,稍后汇报"式的回合收尾:任务未完成就结束回合 = 任务结果永久丢失。',
  '- 需要结果的命令(构建/测试/截图/检查等)也可以直接前台运行并耐心等待完成。',
  '- 唯一例外:常驻服务进程(如 dev server)后台拉起后,轮询端口就绪即可继续后续步骤,不必等它退出。',
  '- 全部工作真正完成后才输出最终总结;确实无法继续时,明确说明阻塞原因后结束。',
].join('\n')

/** 多轮延续说明:明确历史与新指令的边界,防止 AGY 把历史记录当新任务从头重跑(实测)。
 * 仅在无 conversation 记忆而全量重发时出现(进程重启后记忆丢失等罕见场景;
 * 正常续走 --conversation + resumeReplayPrompt,只补发增量)。 */
const CONTINUATION_NOTE
  = '注意:这是同一任务的延续。以下 User/Assistant 交替内容是先前会话的历史记录,仅供了解已完成的工作;'
    + '不要重做已完成的部分,也不要把历史里的内容当作待办任务;只执行最后一条 User 消息。'

/** 序列化结果:prompt 文本 + 资源清理。 */
export interface SerializedPrompt {
  prompt: string
  cleanup: () => Promise<void>
}

/** 消息来源(压缩 checkpoint / own 轮 / 用户输入判定用)。 */
function sourceOf(message: Message): { kind?: unknown; provider?: unknown; plugin?: unknown } {
  return (message.source ?? {}) as { kind?: unknown; provider?: unknown; plugin?: unknown }
}

/**
 * 一条消息的可读文本(text + tool-call + tool-result 内嵌文本;图片走路径提示)。
 *
 * tool-call 不加分支的话纯工具调用的 assistant 消息文本为空、整条被跳过,
 * 接收方只见结果不见调用(实测丢失)。
 */
function messageText(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool-call') {
      parts.push(`[tool call: ${block.name} ${block.arguments}]`)
    } else if (block.type === 'tool-result') {
      for (const inner of block.content) {
        if (inner.type === 'text') parts.push(inner.text)
      }
    }
  }
  return parts.join('')
}

/** 续跑提示消息(无具体可补发内容时的发送载体)。 */
function continueMessage(): Message {
  return { role: 'user', content: [{ type: 'text', text: CONTINUE_PROMPT }] } as unknown as Message
}

/**
 * 续跑提示的完整 prompt(带运行时约束):调用方在无具体补发内容的重试轮
 * (attempt>1)使用。每次都是新进程,约束必须随行。
 */
export function continuationPrompt(): string {
  return `${RUNTIME_CONSTRAINTS}\n\nUser: ${CONTINUE_PROMPT}`
}

/**
 * 序列化主体:前缀(约束/系统提示)+ 消息文本;图片落盘为路径提示。
 * 超长整体转临时文件,cleanup 等删除真正完成。
 */
async function serializeParts(
  ctx: Context,
  prefix: string[],
  messages: readonly Message[],
): Promise<SerializedPrompt> {
  const parts = [...prefix]
  const tempFiles: string[] = []
  const attachments = ctx.get('attachments')

  for (const message of messages) {
    const text = messageText(message)
    const notePaths: string[] = []
    if (attachments !== undefined) {
      for (const block of message.content) {
        if (block.type !== 'image') continue
        try {
          const stored = await attachments.readImage(block.attachment)
          const ext = IMAGE_EXT[stored.ref.mediaType] ?? 'img'
          const file = join(tmpdir(), `agy-${randomUUID()}.${ext}`)
          await writeFile(file, stored.data)
          tempFiles.push(file)
          notePaths.push(file)
        } catch {
          // 附件不可读则跳过该图。
        }
      }
    }
    if (text.length === 0 && notePaths.length === 0) continue
    const label = message.role === 'assistant' ? 'Assistant' : 'User'
    const note = notePaths.length > 0
      ? `\n[附带图片,请读取以下本地路径查看:${notePaths.join(', ')}]`
      : ''
    parts.push(`${label}: ${text}${note}`)
  }

  let prompt = parts.join('\n\n')
  // 超长 prompt 写入临时文件,命令行只给短引用(AGY 会自己读取文件)。
  if (prompt.length > FILE_REF_THRESHOLD) {
    const file = join(tmpdir(), `agy-task-${randomUUID()}.txt`)
    await writeFile(file, prompt)
    tempFiles.push(file)
    prompt = `请先读取任务描述文件并完整阅读: ${file}\n文件中的内容是要执行的任务;读取后按其中要求执行,不要修改该文件。`
  }

  // 等删除真正完成:调用方在流结束后 await 本函数,fire-and-forget 会留下
  // 竞态(实测),且图片/任务临时文件会堆积在 temp 目录。
  const cleanup = async (): Promise<void> => {
    await Promise.allSettled(tempFiles.map(p => unlink(p).catch(() => {})))
  }
  return { prompt, cleanup }
}

/** 首轮全量序列化(system + 消息)。仅当本 dsh 会话没有 AGY conversation 记忆时使用。 */
export async function buildPrompt(
  ctx: Context,
  options: GenerateOptions,
): Promise<SerializedPrompt> {
  const prefix: string[] = []
  if (options.system !== undefined && options.system.length > 0) {
    prefix.push(`System instructions:\n${options.system}`)
  }
  prefix.push(RUNTIME_CONSTRAINTS)
  // 无记忆的全量重发(进程重启后记忆丢失等罕见场景):历史多于一条说明是
  // 续跑而非首轮,明确边界防止 AGY 把历史当新任务从头重跑。
  if (options.messages.length > 1) prefix.push(CONTINUATION_NOTE)
  return await serializeParts(ctx, prefix, options.messages)
}

/**
 * 续聊兜底:只发**用户自己发的**最后一条消息(锚点缺失/历史被压缩收缩时)。
 *
 * 必须按 `source.kind === 'user'` 精确取:插件注入的上下文(系统提醒、
 * 工作区指令、技能目录)同样是 user 角色、且排在用户消息**之后**,
 * 按"最后一条 user 角色"取会把用户输入整条顶掉——实测:压缩完成后
 * 被 claim 的排队消息丢失,模型只看到技能目录提醒。
 */
export async function lastUserPrompt(
  ctx: Context,
  messages: readonly Message[],
): Promise<SerializedPrompt> {
  const last = [...messages].reverse().find(
    message => message.role === 'user' && sourceOf(message).kind === 'user',
  )
  const text = last === undefined ? '' : messageText(last)
  const hasImage = last !== undefined && last.content.some(block => block.type === 'image')
  if (last === undefined || (text.trim().length === 0 && !hasImage)) {
    return await serializeParts(ctx, [RUNTIME_CONSTRAINTS], [continueMessage()])
  }
  return await serializeParts(ctx, [RUNTIME_CONSTRAINTS], [last])
}

/**
 * 续聊补发:把"AGY conversation 尚未见过"的消息补发给 AGY。
 *
 * 主锚是**消息 id**(`lastSentMessageId`):上次发送覆盖到的最后一条消息。
 * 数量锚(`sentCount`)在历史被压缩/编辑后不可靠。锚点找不到(已被压缩
 * 移除)或数量锚不可信(越界/已发区内出现压缩 checkpoint)时,**不做整体
 * 重发**——AGY 服务端 conversation 有自己的完整上下文,重发会重复膨胀且被
 * 当作新任务从头重跑(实测);只补发最后一条用户输入兜底,保证最新指令必达。
 *
 * 补发按 User/Assistant 序列化;AGY 自己产生的消息(assistant/tool)跳过,
 * 其他模型轮次与用户输入完整补上。
 * @param ctx - 插件上下文(读取附件服务)。
 * @param messages - 当前 dsh 折叠视图的完整消息序列。
 * @param sentCount - 旧的数量锚(仅兼容历史记录;新锚见下)。
 * @param lastSentMessageId - 上次发送覆盖到的最后一条消息 id(主锚,可选)。
 * @param ownProvider - "本端"provider 名(其 assistant 轮次已在 AGY 历史里)。
 */
export async function resumeReplayPrompt(
  ctx: Context,
  messages: readonly Message[],
  sentCount: number | undefined,
  lastSentMessageId?: string,
  ownProvider: string = 'agy',
): Promise<SerializedPrompt> {
  if (lastSentMessageId !== undefined && lastSentMessageId.length > 0) {
    const at = messages.findIndex(message => String(message.id) === lastSentMessageId)
    if (at >= 0) return await replayFrom(ctx, messages, at + 1, ownProvider)
    // 锚点已被压缩移除:dsh surface 里定位不到"AGY 尚未见过"的边界,
    // 只发最后一条用户输入兜底(见上)。
    return await lastUserPrompt(ctx, messages)
  }
  if (sentCount === undefined) return await lastUserPrompt(ctx, messages)
  // 数量锚在两种历史收缩下不可信,都不按它补发:
  // - 越界(大幅压缩):索引必然错位;
  // - 前 sentCount 条里出现压缩 checkpoint(遮蔽段落在已发区内的小幅压缩):
  //   折叠把后续消息拉进"已发"区,未发送的消息会被数量锚静默吞掉。
  if (sentCount > messages.length || hasCompactionCheckpoint(messages, sentCount)) {
    return await lastUserPrompt(ctx, messages)
  }
  return await replayFrom(ctx, messages, sentCount, ownProvider)
}

/**
 * 前 limit 条里是否有压缩 checkpoint(dsh 原生与镜像压缩的 replace 消息,
 * source 同形:`{ kind:'plugin', plugin:'compact' }`)。数量锚遇到它即不可信。
 */
function hasCompactionCheckpoint(messages: readonly Message[], limit: number): boolean {
  for (let index = 0; index < Math.min(limit, messages.length); index += 1) {
    const source = sourceOf(messages[index]!)
    if (source.kind === 'plugin' && source.plugin === 'compact') return true
  }
  return false
}

/**
 * 从 start 起补发:对**整个尾段**逐条过滤,而不是只找第一条新消息。
 *
 * 跳过(AGY conversation 已有):AGY 自己的 assistant 回答及其跟随的工具结果
 * (含 start 之后的——期间穿插的 own 轮同样已在 AGY 历史里,重发只会膨胀
 * 上下文)、已中途转发的插入消息。跟踪"当前这一轮是谁跑的"贯穿全序列:
 * 其他模型的回答/工具结果必须补发,否则 AGY 看不到那段上下文(实测:补发
 * 把 assistant 一律当"自己的"跳过,期间内容全丢)。
 * 全部跳过 → 发续跑提示(调用方不会再有空闲轮次消费补发结果)。
 */
async function replayFrom(
  ctx: Context,
  messages: readonly Message[],
  start: number,
  ownProvider: string,
): Promise<SerializedPrompt> {
  let ownTurn = true
  const selected: Message[] = []
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index]!
    const source = sourceOf(message)
    if (message.role === 'assistant') {
      ownTurn = source.kind === 'model' && source.provider === ownProvider
      if (ownTurn) continue
    } else if (source.kind === 'tool' && ownTurn) {
      continue
    }
    selected.push(message)
  }
  if (selected.length === 0) {
    return await serializeParts(ctx, [RUNTIME_CONSTRAINTS], [continueMessage()])
  }
  return await serializeParts(ctx, [RUNTIME_CONSTRAINTS], selected)
}
