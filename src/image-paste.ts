/**
 * Image relay(后端输入后处理):让文本主模型(如 DeepSeek V4 Flash)支持"输入栏贴图"。
 *
 * 模式:纯插件内、用户完全无感——不新增 provider 路由、不改模型路由、
 * 不改前端、不修改任何其它插件、不改 dsh 源码。**不写工作区磁盘**。
 *
 * 处理策略(参考 dsh-vision-toolkit 的 stream 就地读图):
 * - llm/stream 监听器转换 ImageBlock 时,**就地读图并生成描述文本**进消息:
 *   attachment 服务按完整 ref 读字节 → 临时文件(系统 temp,用完即删)
 *   → AGY/Gemini 读图 → 替换为"[用户粘贴的图片内容: <AGY 描述>]"文本;
 *   主代理直接看到图片描述,**无需调用任何工具**。
 * - **缓存**:同一附件(内容寻址 attachmentId)只读图一次,后续请求从缓存取
 *   描述文本,保证确定性(网关 prompt 缓存命中)且不重复消耗 AGY。
 * - read_image_agy 工具保留:本地磁盘路径读图、以及附件引用的兜底读取。
 *
 * 两个环节:
 *   1. 包装 llm.resolveModelInfo:文本模型被声明为支持 image 输入
 *      (记录在 imageDeclared 集合)——绕过 api-proxy 的
 *      MODEL_DOES_NOT_SUPPORT_IMAGES 拒绝;
 *   2. llm/stream waterfall 监听器:仅对 imageDeclared 中的模型,把
 *      ImageBlock 就地读图生成描述文本 → 接管调用原 adapter.stream。
 * @module llm-agy/image-paste
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { agyReadImage } from './read-image.js'

/** 被本插件声明为支持 image 的文本模型路由(provider:model)。 */
const imageDeclared = new Set<string>()

/** 原生支持多模态(image)的模型路由(provider:model):始终跳过转换拦截。 */
const imageCapable = new Set<string>()

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

/** 消息内容是否含 ImageBlock。 */
function hasImage(messages: readonly Message[]): boolean {
  return messages.some((m) => m.content.some((b) => b.type === 'image'))
}

/**
 * 就地读图:attachment 服务按完整 ref 读字节 → 临时文件 → AGY 读图 → 描述文本。
 * 描述按 attachmentId 缓存(内容寻址,进程内;同附件只读一次)。
 */
async function describeImage(
  ctx: Context,
  block: Extract<ContentBlock, { type: 'image' }>,
  command: string,
  proxy: string,
): Promise<string> {
  const attachmentId = String(block.attachment?.attachmentId ?? '')
  if (attachmentId.length > 0) {
    const cached = describedImages.get(attachmentId)
    if (cached !== undefined) return cached
  }

  const attachments = ctx.get('attachments') as {
    readImage?: (ref: unknown, signal?: AbortSignal) => Promise<{ data: Uint8Array; mediaType?: string }>
  } | undefined
  if (!attachments?.readImage) {
    return '[用户粘贴了一张图片,但附件服务不可用,图片无法读取]'
  }
  const stored = await attachments.readImage(block.attachment)
  if (stored === undefined || stored.data.byteLength === 0) {
    return '[用户粘贴了一张图片,但附件读取失败,图片无法读取]'
  }

  // 临时文件(不落工作区),AGY 读图后立即清理。
  const dir = mkdtempSync(join(tmpdir(), 'llm-agy-paste-'))
  const ext = extensionOf(stored.mediaType ?? block.attachment?.mediaType ?? 'image/png')
  const tmp = join(dir, `image.${ext}`)
  let description: string
  try {
    writeFileSync(tmp, stored.data)
    description = await agyReadImage(command, proxy, tmp)
  } catch (error) {
    description = `[用户粘贴的图片读取失败:${String(error).slice(0, 200)}]`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  if (attachmentId.length > 0) describedImages.set(attachmentId, description)
  return description
}

/** 已描述图片缓存:attachmentId → AGY 描述(进程内,内容寻址)。 */
const describedImages = new Map<string, string>()

/** 统一描述模板:最新输入与历史消息共用同一模板(内容确定性,缓存命中)。 */
function imageContentText(description: string): string {
  return `[用户粘贴的图片内容:${description}]`
}

/**
 * 转换请求消息:把**任何角色**消息里的 ImageBlock 都转换为描述文本——
 * 文本模型(如 deepseek-v4-flash)的流式适配器会在序列化时硬拒裸图片块
 * (`pi-ai model "X" does not support image input`),所以历史里的图片块也必须
 * 转走,不能原样透传。
 *
 * 角色不限:除了用户粘贴的图片(user 消息),工具结果(tool 消息)同样会
 * 携带图片块——原生 `read_image` 的返回就是文本信封 + ImageBlock。只转换
 * user 会让工具读出的图片漏网,并在下一次请求时触发适配器的硬拒。
 *
 * - 所有图片块(最新输入与历史)统一使用同一描述模板(带 AGY 描述);
 * - 转换是**确定性**的:同一附件永远映射到同一描述文本(内容寻址缓存),
 *   每次请求内容完全一致,网关 prompt 缓存照常命中;
 * - 同轮工具调用后的继续请求同样按此规则转换,内容保持与前序请求一致。
 *
 * 完全不改动会话数据(日志、surface 都不碰),只影响本次请求的负载。
 */
export async function convertPastedImages(
  ctx: Context,
  messages: readonly Message[],
  getOptions: () => { command: string; proxy: string },
): Promise<Message[]> {
  let changed = false
  const transformed: Message[] = []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (!message.content.some((b) => b.type === 'image')) {
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
      const imageBlock = block as Extract<ContentBlock, { type: 'image' }>
      const description = await describeImage(ctx, imageBlock, getOptions().command, getOptions().proxy)
      content.push({ type: 'text', text: imageContentText(description) })
    }
    transformed.push({ ...message, content })
  }
  return changed ? transformed : [...messages]
}

/**
 * 安装图片中继(返回注销函数,关闭开关时可整体移除):
 * 1. 包装 llm.resolveModelInfo,把文本模型声明为支持 image(绕过 api-proxy 拒绝);
 * 2. llm/stream 监听器(global)把图片就地读成描述文本,再重走 llm.stream,
 *    使文本模型也能处理含图会话。
 */
export function installImageRelay(
  ctx: Context,
  getOptions: () => { command: string; proxy: string },
): (() => void) | undefined {
  const llm = ctx.get('llm') as {
    resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<LlmResolvedModelInfo>
    stream?: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  } | undefined
  if (!llm || typeof llm.stream !== 'function') return undefined
  const streamRequest = llm.stream.bind(llm)
  if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined

  // 1. 包装 resolveModelInfo:文本模型 → 声明 image 能力。
  const original = llm.resolveModelInfo.bind(llm)
  const wrapped = async (provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> => {
    const info = await original(provider, model, signal)
    const key = `${provider}:${model}`
    if (info?.inputModalities !== undefined) {
      if (info.inputModalities.includes('image')) {
        // 原生多模态:跳过转换拦截(图片原样给模型)。
        imageCapable.add(key)
        return info
      }
      imageDeclared.add(key)
      return { ...info, inputModalities: [...info.inputModalities, 'image'] }
    }
    return info
  }
  llm.resolveModelInfo = wrapped

  // 2. llm/stream 监听器:确认模型吃不下图片后,就地读图并改写本次请求。
  //
  // `global: true` 是必需的:事件由 llm 服务在它自己的 ctx 上 emit
  // (`this.ctx.waterfall(this, 'llm/stream', ...)`),插件作用域的普通监听器
  // 收不到兄弟作用域的事件——不加它,本监听器一次都不会触发(官方
  // session-title / agent-loop invariant 同样用 global 注册)。
  const off = ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    // 多模态模型(原生支持 image)始终跳过,图片原样给模型。
    const key = `${options.provider}:${options.model}`
    if (imageCapable.has(key)) return next()
    if (!hasImage(options.messages)) return next()

    return (async function* (): AsyncGenerator<StreamChunk> {
      // 路由能力未知时先解析一次,不能只依赖 `imageDeclared` 的惰性填充:
      // 该集合只在有人调用过 resolveModelInfo 后才会有记录。带着历史图片
      // 继续对话(不再调用原生 read_image)时它仍是空的,若直接跳过转换,
      // 裸图片块会被适配器硬拒(`does not support image input`)。
      if (!imageDeclared.has(key)) {
        let resolved: LlmResolvedModelInfo | undefined
        try {
          resolved = await llm.resolveModelInfo?.(options.provider, options.model)
        } catch { /* 解析失败按未知处理,走转换兜底 */ }
        if (resolved?.inputModalities?.includes('image') === true) {
          imageCapable.add(key)
          yield* next()
          return
        }
        // 解析出能力清单(不含 image)即记住它是文本模型;解析不出也照常
        // 转换——对一个会硬拒的适配器,转换永远比放行安全。
        if (resolved?.inputModalities !== undefined) imageDeclared.add(key)
      }
      // options 是只读的(严格模式下赋值会抛错),而 waterfall 的 next() 不
      // 接受参数,所以只能构造新对象后重走公开的 llm.stream:完整监听链
      // (重试/检查点/会话标题)照常生效。转换后 messages 已不含图片块,
      // 重入本监听器时会命中 `hasImage === false` 直接放行,不会递归。
      const before = options.messages
      const messages = await convertPastedImages(ctx, options.messages, getOptions)
      yield* streamRequest({ ...options, messages })
    })()
  }, { global: true })

  return () => {
    // 仅当 resolveModelInfo 仍是本插件包装时才恢复原函数(防御第三方再次包装)。
    if (llm.resolveModelInfo === wrapped) llm.resolveModelInfo = original
    off()
  }
}
