/**
 * Image relay(后端输入后处理):让文本主模型(如 DeepSeek V4 Flash)支持"输入栏贴图"。
 *
 * 模式:纯插件内、用户完全无感——不新增 provider 路由、不改模型路由、
 * 不改前端、不修改任何其它插件、不改 dsh 源码。
 *
 * 处理策略:**只消费最新一条用户输入**。
 * - dsh 的请求是无状态的,每轮都从会话事件重建完整历史,历史里的图片块会在
 *   每个请求里反复出现——只把"最新一条用户输入"里的图片物化为路径文本,
 *   历史消息里的图片块在请求级直接丢弃(不落盘、不转换、不写会话日志),
 *   因此同一张图永远不会被重复消费,也不会堆积重复文件。
 * - 同一轮内的多次请求(工具调用后继续)会再次处理同一条最新输入,靠
 *   附件级缓存复用同一路径,不产生新文件。
 *
 * 两个环节:
 *   1. 包装 llm.resolveModelInfo:文本模型被声明为支持 image 输入
 *      (记录在 imageDeclared 集合)——绕过 api-proxy 的
 *      MODEL_DOES_NOT_SUPPORT_IMAGES 拒绝;
 *   2. llm/stream waterfall 监听器:仅对 imageDeclared 中的模型,把
 *      最新用户输入里的 ImageBlock 从 attachment 读字节 → 落盘到工作区
 *      .dsh-llm-agy/tmp/pasted-images/ → 替换为"[图片已保存到 <路径>]"文本
 *      → 接管调用原 adapter.stream(文本模型收到路径文本);
 *   3. 主代理调用 read_image(AGY 版)或 subagent_agy_ui 看图。
 * @module llm-agy/image-paste
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'

/** 图片保存目录(相对会话工作区)。 */
const PASTE_DIR = '.dsh-llm-agy/tmp/pasted-images'

/**
 * 已物化图片缓存:`<sessionId>|<attachmentId>` → 已落盘的绝对路径。
 *
 * 同一轮内的多次请求会重复经过监听器(工具调用后继续),缓存让同一附件只落盘
 * 一次、路径复用。
 */
const materializedImages = new Map<string, string>()

/** 文件号自增器:保证同一毫秒内多次落盘也不会碰撞文件名。 */
let writeSeq = 0

/** 物化缓存键:同一附件在同一会话只落盘一次;不同会话允许各自落盘。 */
function materializeKey(sessionId: string | undefined, attachmentId: string | undefined): string {
  return `${sessionId ?? ''}|${attachmentId ?? ''}`
}

/** 被本插件声明为支持 image 的模型路由(provider:model)。 */
const imageDeclared = new Set<string>()

/** 消息内容是否含 ImageBlock。 */
function hasImage(messages: readonly Message[]): boolean {
  return messages.some((m) => m.content.some((b) => b.type === 'image'))
}

/** 读 attachment 图片字节并落盘到工作区,返回绝对路径(同一附件同会话只写一次)。 */
export async function materializeImage(
  ctx: Context,
  block: Extract<ContentBlock, { type: 'image' }>,
  sessionId: string | undefined,
): Promise<string> {
  const id = String(block.attachment?.attachmentId ?? 'paste').replace(/[^a-zA-Z0-9_-]/g, '_')
  const cacheKey = materializeKey(sessionId, id)
  const cached = materializedImages.get(cacheKey)
  if (cached !== undefined) return cached

  const attachments = ctx.get('attachments') as {
    readImage?: (ref: unknown, signal?: AbortSignal) => Promise<{ data: Uint8Array }>
  } | undefined
  if (!attachments?.readImage) {
    return `[用户粘贴了一张图片,但附件服务不可用;请让用户改用 read_image 并提供图片路径]`
  }
  const out = await attachments.readImage(block.attachment)
  if (out === undefined) {
    return `[用户粘贴了一张图片,但附件读取失败;请让用户改用 read_image 并提供图片路径]`
  }
  const { data } = out

  // 工作区根:会话 header 的 cwd(若可用),否则宿主 cwd。
  let workspace = process.cwd()
  try {
    const sessions = ctx.get('sessions') as { get: (id: string) => { header?: { cwd?: string } } | undefined } | undefined
    const session = sessionId === undefined ? undefined : sessions?.get(sessionId)
    if (session?.header?.cwd && session.header.cwd.length > 0) workspace = session.header.cwd
  } catch { /* cwd 不可用时用宿主 cwd */ }

  const dir = join(workspace, PASTE_DIR)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id.slice(0, 40)}-${Date.now()}-${writeSeq++}.${extensionOf(block.attachment?.mediaType ?? 'image/png')}`)
  writeFileSync(path, data)
  materializedImages.set(cacheKey, path)
  return path
}

/** 图片媒体类型 → 扩展名。 */
function extensionOf(mediaType: string): string {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/gif': return 'gif'
    case 'image/webp': return 'webp'
    default: return 'img'
  }
}

/** 路径提示文本:转换图片块时注入,让模型调用 read_image 查看。 */
function imagePromptText(path: string): string {
  return `[用户粘贴了一张图片,已保存到本地:${path}。请调用 read_image 工具查看并分析这张图片。]`
}

/**
 * 转换请求消息:**只消费最新一条用户输入**。
 *
 * - 最新一条 user 消息里的 ImageBlock:物化落盘 + 替换为路径提示文本;
 * - 更早的 user 消息里的 ImageBlock(历史重放):请求级直接丢弃,不落盘、
 *   不转换、不写会话日志——同一张图永远不会被重复消费;
 * - 历史图片消息丢弃后无剩余内容时,整条从请求中移除。
 *
 * 完全不改动会话数据(日志、surface 都不碰)。
 */
export async function convertPastedImages(
  ctx: Context,
  messages: readonly Message[],
  sessionId?: string,
): Promise<Message[]> {
  // 最新一条用户消息的下标:只有它携带的图片会被物化并转换为路径文本。
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i
      break
    }
  }

  let changed = false
  const transformed: Message[] = []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (message.role !== 'user' || !message.content.some((b) => b.type === 'image')) {
      transformed.push(message)
      continue
    }
    changed = true
    const content: ContentBlock[] = []
    for (const block of message.content) {
      if (block.type !== 'image') {
        content.push(block)
        continue
      }
      if (i !== lastUserIndex) continue // 历史图片:请求级丢弃,不消费。
      const path = await materializeImage(ctx, block as Extract<ContentBlock, { type: 'image' }>, sessionId)
      content.push({ type: 'text', text: imagePromptText(path) })
    }
    // 历史图片消息被丢弃后没有剩余内容:整条从请求中移除。
    if (content.length === 0) continue
    transformed.push({ ...message, content })
  }
  return changed ? transformed : [...messages]
}

/**
 * 安装图片中继:
 * 1. 包装 llm.resolveModelInfo,把文本模型声明为支持 image(绕过 api-proxy 拒绝);
 * 2. llm/stream 监听器对声明过的模型转换 ImageBlock。
 */
export function installImageRelay(ctx: Context): void {
  const llm = ctx.get('llm') as {
    resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<LlmResolvedModelInfo>
    adapters?: Map<string, { adapter?: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> } }>
  } | undefined
  if (!llm || typeof llm.resolveModelInfo !== 'function') return

  // 1. 包装 resolveModelInfo:文本模型 → 声明 image 能力。
  const original = llm.resolveModelInfo.bind(llm)
  llm.resolveModelInfo = async (provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> => {
    const info = await original(provider, model, signal)
    if (info?.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      imageDeclared.add(`${provider}:${model}`)
      return { ...info, inputModalities: [...info.inputModalities, 'image'] }
    }
    return info
  }

  // 2. llm/stream 监听器:仅处理被声明的模型,只消费最新一条用户输入里的图片。
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    if (!imageDeclared.has(`${options.provider}:${options.model}`)) return next()
    if (!hasImage(options.messages)) return next()
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    const adapter = llm.adapters?.get(options.provider)?.adapter
    if (!adapter || typeof adapter.stream !== 'function') return next()

    return (async function* (): AsyncGenerator<StreamChunk> {
      const messages = await convertPastedImages(ctx, options.messages, sessionId)
      yield* adapter.stream({ ...options, messages })
    })()
  })
}
