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

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** AGY 读图:同步执行,返回描述文本。 */
export function agyReadImage(command: string, proxy: string, filePath: string): string {
  const prompt = `请查看这张图片并描述你看到的内容:${filePath}。给出准确、详细的中文描述,回答问题时直接依据图片内容。`
  const r = spawnSync(command, [
    '-p', prompt,
    '--output-format', 'text',
    '--print-timeout', '10m',
    '--dangerously-skip-permissions',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90_000,
    env: proxy
      ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy }
      : { ...process.env },
  })
  if (r.error) throw new Error(`AGY 读图失败:${String(r.error)}`)
  if (r.status !== 0) throw new Error(`AGY 读图失败(exit ${r.status}):${(r.stderr ?? '').slice(0, 200)}`)
  const text = (r.stdout ?? '').trim()
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
 * 返回描述文本;无法解析/读取失败返回 undefined。
 */
async function readImageByAttachment(
  ctx: Context,
  filePath: string,
  command: string,
  proxy: string,
): Promise<string | undefined> {
  const ref = attachmentRefFrom(filePath)
  if (ref === undefined) return undefined

  const attachments = ctx.get('attachments') as {
    readImage?: (ref: unknown, signal?: AbortSignal) => Promise<{ data: Uint8Array; mediaType?: string }>
  } | undefined
  if (!attachments?.readImage) return undefined

  let out: { data: Uint8Array; mediaType?: string } | undefined
  try {
    out = await attachments.readImage(ref)
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
    return agyReadImage(command, proxy, tmp)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 生成 `read_image_agy` 工具定义(全局常驻,独立命名)。 */
export function agyReadImageAgyTool(ctx: Context, getOptions: () => { command: string; proxy: string }) {
  return defineTool({
    name: 'read_image_agy',
    description:
      'Read a PNG/JPEG/WebP/GIF file and describe its content (via AGY/Gemini vision). '
      + 'THE recommended tool for analyzing any image (screenshots, mockups, pasted images). '
      + 'Accepts a local file path or an attachment id (e.g. sha256:...) from a pasted image. '
      + 'Works with any model, including text-only ones. Call this directly; do not delegate image reading to a subagent.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, or an attachment id from a pasted image.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.path}</path>\n<content>${value.description}</content>`,
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const filePath = args.file_path
      if (typeof filePath !== 'string' || filePath.trim().length === 0) {
        throw new Error('file_path must be a non-empty string')
      }
      const { command, proxy } = getOptions()

      // 1) 磁盘路径:直接读。
      if (existsSync(filePath)) {
        const description = agyReadImage(command, proxy, filePath)
        return { path: filePath, description }
      }

      // 2) 附件引用(粘贴图片):attachment 服务读字节 → 临时文件 → AGY 读图。
      const byAttachment = await readImageByAttachment(ctx, filePath, command, proxy)
      if (byAttachment !== undefined) {
        return { path: filePath, description: byAttachment }
      }

      throw new Error(`cannot read "${filePath}": no such file (not a local path or a known attachment id)`)
    },
  })
}

/** 注册 read_image_agy 工具(全局常驻),返回注销函数。 */
export function registerReadImageAgy(ctx: Context, getOptions: () => { command: string; proxy: string }): (() => void) | undefined {
  try {
    return ctx.tools.register(agyReadImageAgyTool(ctx, getOptions))
  } catch {
    /* 已注册则跳过 */
    return undefined
  }
}
