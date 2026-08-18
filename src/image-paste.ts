/**
 * Image relay(后端输入后处理):让文本主模型(如 DeepSeek V4 Flash)支持"输入栏贴图"。
 *
 * 模式:纯插件内、用户完全无感——不新增 provider 路由、不改模型路由、
 * 不改前端、不修改任何其它插件、不改 dsh 源码。
 *
 * 两个环节:
 *   1. 包装 llm.resolveModelInfo:文本模型被声明为支持 image 输入
 *      (记录在 imageDeclared 集合)——绕过 api-proxy 的
 *      MODEL_DOES_NOT_SUPPORT_IMAGES 拒绝;
 *   2. llm/stream waterfall 监听器:仅对 imageDeclared 中的模型,把
 *      ImageBlock 从 attachment 读字节 → 落盘到工作区
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
 * 会话历史里的 ImageBlock 会随每个请求反复经过 llm/stream 监听器,若不缓存,
 * 同一张粘贴图会在每次请求时以新的 Date.now() 文件名重新落盘,堆积大量
 * 内容相同、名称不同的文件(实测单图可达数百份)。
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
  // 同一附件重复经过本函数(每次请求都会重放含图片的历史消息)时,直接复用已落盘路径,
  // 连附件字节都不必重读。
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

/** 转换消息:ImageBlock → 路径文本;返回新消息数组。 */
export async function convertPastedImages(
  ctx: Context,
  messages: readonly Message[],
  sessionId?: string,
): Promise<Message[]> {
  let changed = false
  const transformed: Message[] = []
  for (const message of messages) {
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
      const image = block as Extract<ContentBlock, { type: 'image' }>
      const id = String(image.attachment?.attachmentId ?? 'paste').replace(/[^a-zA-Z0-9_-]/g, '_')
      // 图片只消费一次:首次转换落盘并提示模型阅读;后续请求重放历史时直接丢弃
      // 该图片块,不再让模型重复消费同一张图。
      if (materializedImages.has(materializeKey(sessionId, id))) continue
      const path = await materializeImage(ctx, image, sessionId)
      content.push({
        type: 'text',
        text: `[用户粘贴了一张图片,已保存到本地:${path}。请调用 read_image 工具查看并分析这张图片。]`,
      })
    }
    // 图片全部被丢弃后保留一个最小占位,避免空内容消息。
    if (content.length === 0) {
      content.push({ type: 'text', text: '[图片已在上轮消息中消费]' })
    }
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

  // 2. llm/stream 监听器:仅处理被声明的模型,转换 ImageBlock 后接管调用原 adapter。
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
