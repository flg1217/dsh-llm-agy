/**
 * read_image_agy 工具(全局常驻):让任何文本主模型都能看图。
 *
 * 背景:tool-fs 的原生 `read_image` 要求当前模型声明 image 输入能力,
 * DeepSeek V4 Flash 等文本模型调用它会被拒(does not declare image input)。
 *
 * 本工具在 llm-agy 插件内全局注册(常驻,不依赖任何预设):
 * - 接收本地图片路径 → 直接 spawn AGY(Gemini,支持视觉)读图 → 返回文字描述;
 * - 主代理(文本模型)把它当作普通工具使用,无需切换模型;
 * - 与 image-paste(ImageBlock→路径)配合:用户粘贴的图片落盘后,
 *   主代理可用本工具查看该图片。
 * @module llm-agy/read-image
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

/** 生成 `read_image_agy` 工具定义(全局常驻,独立命名)。 */
export function agyReadImageAgyTool(getOptions: () => { command: string; proxy: string }) {
  return defineTool({
    name: 'read_image_agy',
    description:
      'Read a PNG/JPEG/WebP/GIF file and describe its content (via AGY/Gemini vision). '
      + 'THE recommended tool for analyzing any image (screenshots, mockups, pasted images). '
      + 'Works with any model, including text-only ones. Call this directly; do not delegate image reading to a subagent.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
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
      if (!existsSync(filePath)) throw new Error(`cannot read "${filePath}": no such file`)
      const { command, proxy } = getOptions()
      const description = agyReadImage(command, proxy, filePath)
      return { path: filePath, description }
    },
  })
}

/** 注册 read_image_agy 工具(全局常驻)。 */
export function registerReadImageAgy(ctx: Context, getOptions: () => { command: string; proxy: string }): void {
  try {
    ctx.tools.register(agyReadImageAgyTool(getOptions))
  } catch { /* 已注册则跳过 */ }
}
