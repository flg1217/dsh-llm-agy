/**
 * read_image_agy 工具(全局常驻):让任何文本主模型都能看图。
 *
 * 背景:tool-fs 的原生 `read_image` 要求当前模型声明 image 输入能力,
 * DeepSeek V4 Flash 等文本模型调用它会被拒(does not declare image input)。
 *
 * 本工具在 llm-agy 插件内全局注册(常驻,不依赖任何预设):
 * - **附件引用**(image-paste 生成的 attachmentId,如 `sha256:...`):
 *   通过官方 attachment 服务按引用读字节 → 写入系统临时文件(用完即删)
 *   → AGY 读图;不写工作区磁盘;
 * - **磁盘路径**(本地图片文件/子代理路径):直接读取;
 * - 主代理(文本模型)把它当作普通工具使用,无需切换模型。
 * @module llm-agy/read-image
 */

import { runAgyText } from './agy-run.js'
import { IMAGE_MEDIA_BY_EXT, sniffImageMediaType } from './tool-preview.js'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * AGY 读图:同步执行,返回描述文本。
 * @param extra - 调用方对看图方式的额外要求(可选),拼进提示词尾部;
 *   例如"只提取表格里的数字"、"重点说明布局结构"。省略时为通用详细描述。
 */
/**
 * AGY 读图:执行一次完整 AGY 调用,返回描述文本。
 * 超时预算:空闲 60s 无输出即判卡死;总时长用公共执行器默认的 10 分钟软上限
 * (复杂图集审查——如 4×4 逐格检查——持续输出可以远超 3 分钟,62 行输出被
 * 180s 总上限误杀过一次)。读图期间 AGY 持续输出即续命。
 * @param extra - 调用方对看图方式的额外要求(可选),拼进提示词尾部;
 *   例如"只提取表格里的数字"、"重点说明布局结构"。省略时为通用详细描述。
 */
export async function agyReadImage(
  command: string,
  proxy: string,
  filePath: string,
  extra?: string,
  signal?: AbortSignal,
): Promise<string> {
  const focus = extra === undefined || extra.trim().length === 0
    ? ''
    : `

看图要求:${extra.trim()}`
  // 无额外要求时保持原有提示词一字不变(中继结果按附件缓存,措辞即内容)。
  const prompt = focus.length === 0
    ? `请查看这张图片并描述你看到的内容:${filePath}。给出准确、详细的中文描述,回答问题时直接依据图片内容。`
    : `请查看这张图片:${filePath}。给出准确、详细的中文描述,回答问题时直接依据图片内容。${focus}`
  const text = (await runAgyText({
    command,
    prompt,
    proxy,
    // 超时预算跟随公共默认(idle 150s / total 600s):深度审查任务中 AGY 的
    // thinking 静默期可达 2~3 分钟,过紧的空闲阈值会把"憋大招"误判为卡死
    // (实测 159s 处静默被 60s 空闲阈值误杀;用户报告的 180s 空闲超时同性质)。
    timeouts: {},
    // 用户停止对话/回合中断 → kill AGY 子进程并抛出中断
    // (不透传的话读图会无视停止,必须等结果或撞 10 分钟总上限)。
    signal,
  })).trim()
  if (text.length === 0) throw new Error('AGY 读图无输出')
  return text
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

/** UI 呈现用的附件引用字段(saveImage 返回的可 JSON 化子集)。 */
// 用 type 而非 interface:execute 返回值需满足 Record<string, JsonValue>,
// 类型别名才有隐式索引签名兼容。
export type ImageRefValue = {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

/** 本工具用到的附件服务面(只读所需字段;服务可能未挂载)。 */
export interface AttachmentsFace {
  readImage?: (ref: unknown, signal?: AbortSignal) => Promise<{ data: Uint8Array; mediaType?: string }>
  saveImage?: (input: { data: Uint8Array; mediaType: string; name?: string }) => Promise<ImageRefValue>
  imageLimits?: { maxImageBytes?: number }
}

/**
 * 把图片字节提交到附件存储,供工具卡片渲染图片画廊(纯 UI 呈现:
 * 模型可见内容不变,仍是纯文本描述——文本模型路由不会被图片块破坏)。
 * 失败跳过不影响读图结果;跳过原因落 console.warn(可在 dsh stderr 日志查)。
 */
export async function commitImagePresentation(
  attachments: AttachmentsFace | undefined,
  data: Uint8Array,
  mediaType: string,
  name?: string,
): Promise<ImageRefValue | undefined> {
  if (!attachments?.saveImage) return undefined
  try {
    const ref = await attachments.saveImage({ data, mediaType, ...name === undefined ? {} : { name } })
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...ref.name === undefined ? {} : { name: ref.name },
      ...ref.originalDimensions === undefined ? {} : { originalDimensions: ref.originalDimensions },
    }
  } catch (error) {
    console.warn(`[llm-agy] read_image_agy 图片呈现提交失败(跳过画廊): ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** 磁盘路径的呈现附件:读字节(限额内)→ 判定媒体类型 → 提交;正常跳过静默,异常落日志。 */
async function diskImagePresentation(attachments: AttachmentsFace | undefined, diskPath: string): Promise<ImageRefValue | undefined> {
  try {
    const cap = attachments?.imageLimits?.maxImageBytes ?? 20 * 1024 * 1024
    const stat = statSync(diskPath)
    if (!stat.isFile() || stat.size === 0 || stat.size > cap) return undefined
    const data = new Uint8Array(readFileSync(diskPath))
    const mediaType = IMAGE_MEDIA_BY_EXT[extname(diskPath).toLowerCase()] ?? sniffImageMediaType(data)
    if (mediaType === undefined) return undefined
    return await commitImagePresentation(attachments, data, mediaType, basename(diskPath))
  } catch (error) {
    console.warn(`[llm-agy] read_image_agy 图片呈现读取失败(跳过画廊): ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** 从 file_path 解析附件引用:
 * - JSON(完整 ImageAttachmentRef)→ 解析为 ref(可读);
 * - /describe-image/raw/<id> 或纯 id → 仅 attachmentId(缺 metadata 校验,
 *   attachment 服务会拒绝;仅供错误提示)。
 */
function attachmentRefFrom(filePath: string): unknown | undefined {
  const trimmed = filePath.trim()
  if (trimmed.length === 0 || trimmed.length > 4096) return undefined
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed?.attachmentId === 'string' && parsed.attachmentId.length > 0) return parsed
    } catch { /* 非 JSON,继续其它匹配 */ }
  }
  const rawMatch = /\/raw\/([^/?#]+)$/.exec(trimmed)
  if (rawMatch !== null) return { attachmentId: rawMatch[1] }
  if (/^[A-Za-z0-9:_-]+$/.test(trimmed) && !trimmed.includes('/') && !trimmed.includes('\\')) {
    return { attachmentId: trimmed }
  }
  return undefined
}

/**
 * 按附件引用读图:通过 attachment 服务读字节 → 临时文件 → AGY 读图。
 * 返回描述文本与图片字节/媒体类型(供 UI 呈现);无法解析/读取失败返回 undefined。
 */
async function readImageByAttachment(
  attachments: AttachmentsFace | undefined,
  filePath: string,
  command: string,
  proxy: string,
  extra?: string,
  signal?: AbortSignal,
): Promise<{ description: string; data: Uint8Array; mediaType: string } | undefined> {
  const ref = attachmentRefFrom(filePath)
  if (ref === undefined) return undefined

  if (!attachments?.readImage) return undefined

  let out: { data: Uint8Array; mediaType?: string } | undefined
  try {
    out = await attachments.readImage(ref, signal)
  } catch (error) {
    // 附件读取失败:显式抛出,便于诊断(不再静默回退)。
    throw new Error(`read_image_agy: 附件读取失败: ${String(error)}`)
  }
  if (out === undefined || out.data.byteLength === 0) return undefined

  // 写系统临时文件(不落工作区),AGY 读完后立即清理。
  const dir = mkdtempSync(join(tmpdir(), 'agy-read-image-'))
  const mediaType = out.mediaType ?? 'image/png'
  const ext = extensionOf(mediaType)
  const tmp = join(dir, `image.${ext}`)
  try {
    writeFileSync(tmp, out.data)
    const description = await agyReadImage(command, proxy, tmp, extra, signal)
    return { description, data: out.data, mediaType }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 生成 `read_image_agy` 工具定义(全局常驻,独立命名)。
 * @param getOptions - 读当前生效的 AGY 命令与代理。
 * @param getAttachments - 取附件服务(呈现/粘贴引用路径用);未注入或未挂载时
 *   返回 undefined,仅失去画廊与粘贴引用能力,核心读图不受影响。
 */
export function agyReadImageAgyTool(
  getOptions: () => { command: string; proxy: string },
  getAttachments: () => AttachmentsFace | undefined = () => undefined,
) {
  return defineTool({
    name: 'read_image_agy',
    description:
      'Read a PNG/JPEG/WebP/GIF file and describe its content (via AGY/Gemini vision). '
      + 'THE recommended tool for analyzing any image (screenshots, mockups, pasted images). '
      + 'Accepts a local file path or an attachment id (e.g. sha256:...) from a pasted image. '
      + 'Works with any model, including text-only ones. Call this directly; do not delegate image reading to a subagent. '
      + 'Pass `prompt` to steer what to look for (e.g. "list every number in the table", "describe only the layout"); '
      + 'omit it for a full general description.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, or an attachment id from a pasted image.' },
      // 可选参数:不加 `required`(该 schema 只允许 `required: true` 标注必填)。
      prompt: {
        type: 'string',
        description: 'Optional extra instruction for how to read the image, e.g. "只提取表格里的数字" / "重点说明布局结构". '
          + 'Omit for a full general description.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      // 结果内容:[描述信封, 图片块(有已提交引用时)]。图片块有两重作用:
      // 1) 会话附件授权按内容里的 image block 判定(referencedImage),没有它
      //    UI 画廊拿不到 url("Image is not referenced by this session");
      // 2) 纯文本路由不受影响——LlmRuntime.projectImagesForTextModel 会在
      //    派发前把图片投影成确定性占位文本(模型看不到像素,适配器不报错)。
      render: (_args, value) => {
        const blocks = [
          { type: 'text' as const, text: `<path>${value.path}</path>\n<content>${value.description}</content>` },
          // 引用字段从 saveImage 原样透传,形状即 ImageAttachmentRef;
          // 品牌类型(AttachmentId)只在编译期,边界处一次转换即可。
          ...value.image !== undefined
            ? [{ type: 'image' as const, attachment: value.image }]
            : [],
        ]
        return blocks as unknown as ContentBlock[]
      },
      // 呈现元数据:UI 卡片从这读取展示路径与图片引用(与内容块并存——
      // 内容块会随消息序列化到模型请求,元数据只供 UI 装配卡片)。
      presentationMeta: (_args, value) => ({
        path: value.path,
        ...(value.image !== undefined ? { image: value.image } : {}),
      }),
    },
    // 读图只读无副作用,且 AGY 支持并发调用——允许模型同时发的多个读图并行执行,
    // 避免第二个调用在第一个(可能 20~70s)后面白白排队。
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = args.file_path
      if (typeof filePath !== 'string' || filePath.trim().length === 0) {
        throw new Error('file_path must be a non-empty string')
      }
      const { command, proxy } = getOptions()
      // 中断透传:用户停止对话/回合被 abort 时,kill AGY 子进程立即返回,
      // 而不是无视停止等结果或撞总时长上限。
      const signal = exec.signal
      // 额外看图要求(可选):非空才拼进提示词。
      const raw = args.prompt
      const extra = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined

      // 1) 磁盘路径:先按原样读;相对路径用会话工作目录解析
      //    (与官方 tool-fs 一致:exec.agent.session.header.cwd;服务进程 cwd
      //    不是项目根,不解析的话模型发的 `Frontend/.temp/x.png` 会直接失败)。
      let diskPath = filePath
      if (!existsSync(diskPath) && !isAbsolute(diskPath)) {
        const sessionCwd = (exec as {
          agent?: { session?: { header?: { cwd?: string } } }
        })?.agent?.session?.header?.cwd
        if (sessionCwd !== undefined && existsSync(join(sessionCwd, diskPath))) {
          diskPath = join(sessionCwd, diskPath)
        }
      }
      if (existsSync(diskPath)) {
        const description = await agyReadImage(command, proxy, diskPath, extra, signal)
        // 读图成功后提交呈现用附件引用(UI 卡片渲染画廊;纯呈现,失败跳过并落日志)。
        const image = await diskImagePresentation(getAttachments(), diskPath)
        return { path: diskPath, description, ...(image !== undefined ? { image } : {}) }
      }

      // 2) 附件引用(粘贴图片):attachment 服务读字节 → 临时文件 → AGY 读图。
      const byAttachment = await readImageByAttachment(getAttachments(), filePath, command, proxy, extra, signal)
      if (byAttachment !== undefined) {
        const image = await commitImagePresentation(
          getAttachments(), byAttachment.data, byAttachment.mediaType, `image.${extensionOf(byAttachment.mediaType)}`,
        )
        return { path: filePath, description: byAttachment.description, ...(image !== undefined ? { image } : {}) }
      }

      throw new Error(`cannot read "${filePath}": no such file (not a local path or a known attachment id)`)
    },
  })
}

/** 注册 read_image_agy 工具(全局常驻),返回注销函数。
 *
 * 附件服务经 `ctx.inject(['attachments'])` 捕获(对齐 tool-fs 的消费模式):
 * 裸插件 ctx 上 `ctx.get('attachments')` 受 cordis isolate/作用域限制拿不到,
 * inject 会把服务重注入到本插件作用域;服务缺席时工具照常注册,仅失去
 * 画廊/粘贴引用能力。服务热替换时 holder 跟随更新(回调重跑)。
 */
/**
 * 捕获附件服务(裸插件 ctx 的 ctx.get 受 cordis 作用域限制拿不到,inject 会把
 * 服务重注入到本插件作用域;服务缺席/热替换由回调重跑跟随)。
 * read_image_agy 工具与 AGY 适配器(图片工具结果的画廊提交)共用。
 * @returns 取当前附件服务的 getter(未挂载时返回 undefined)。
 */
export function captureAttachments(ctx: Context): () => AttachmentsFace | undefined {
  const holder: { current?: AttachmentsFace } = {}
  try {
    const injectable = ctx as unknown as {
      inject?: (deps: string[], fn: (injected: Context) => (() => void) | void) => unknown
    }
    if (injectable.inject !== undefined) {
      const fiber = injectable.inject(['attachments'], (injected) => {
        holder.current = injected.get('attachments') as AttachmentsFace | undefined
        return () => { holder.current = undefined }
      })
      // cordis fiber 可等待;挂载异常不应阻断调用方注册。
      if (fiber !== undefined && typeof (fiber as { catch?: unknown })?.catch === 'function') {
        (fiber as Promise<unknown>).catch(() => { /* attachments 缺席:无画廊能力 */ })
      }
    }
  } catch { /* 服务解析失败:仅无画廊能力 */ }
  return () => holder.current
}

/** 注册 read_image_agy 工具(全局常驻),返回注销函数。
 *
 * 附件服务经 {@link captureAttachments} 捕获;服务缺席时工具照常注册,仅失去
 * 画廊/粘贴引用能力。
 */
export function registerReadImageAgy(ctx: Context, getOptions: () => { command: string; proxy: string }): (() => void) | undefined {
  const getAttachments = captureAttachments(ctx)
  try {
    const disposeTool = ctx.tools.register(agyReadImageAgyTool(getOptions, getAttachments))
    return () => {
      try { disposeTool?.() } catch { /* 已注销 */ }
    }
  } catch {
    /* 已注册则跳过 */
    return undefined
  }
}
