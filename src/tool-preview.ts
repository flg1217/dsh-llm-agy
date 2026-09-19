/**
 * AGY 工具结果的 dsh 化补全:把"只有路径/摘要"的步骤输出转成可展示的内容。
 *
 * AGY 的 stream-json 对文件类工具只回传路径参数与尺寸摘要行(view_file)或
 * 空结果(replace_file_content/write_to_file)——正文与差异都在 AGY 进程内部,
 * 不进 dsh 事件。适配器与服务跑在同一台机器,按路径自行补全:
 * - 读取:文件头部预览(行号格式,限行数);
 * - 写入/编辑:工具开始时快照原文件,结束时再读一次 → 行级 diff。
 * 全部有界(行数/字节),失败静默返回 undefined(不影响原始结果)。
 * @module llm-agy/tool-preview
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

/** 预览/diff 补全的预算。 */
const MAX_READ_BYTES = 512 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const PREVIEW_LINES = 80
const DIFF_MAX_LINES = 60
const DIFF_CONTEXT_LINES = 3

/** 扩展名 → 图片媒体类型(声明用途;真实格式由魔数嗅探兜底)。 */
export const IMAGE_MEDIA_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 图片魔数嗅探:扩展名缺失或不可信时判定真实格式。 */
export function sniffImageMediaType(data: Uint8Array): string | undefined {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 3 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  if (data.length >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return undefined
}

/**
 * 读取图片文件字节(限额内)。view_file 读到的是图片时,适配器走"图片块"
 * 通道(会话附件授权 + UI 画廊),而不是把二进制当文本预览。
 * @param filePath - 绝对路径。
 * @param maxBytes - 字节上限(默认 20MB)。
 * @returns 字节与媒体类型;非图片/超限/不可读返回 undefined。
 */
export function readImageFile(
  filePath: unknown,
  maxBytes = MAX_IMAGE_BYTES,
): { data: Uint8Array; mediaType: string } | undefined {
  if (typeof filePath !== 'string' || filePath.length === 0) return undefined
  try {
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) return undefined
    const data = new Uint8Array(readFileSync(filePath))
    const declared = IMAGE_MEDIA_BY_EXT[extname(filePath).toLowerCase()]
    const mediaType = declared ?? sniffImageMediaType(data)
    if (mediaType === undefined) return undefined
    return { data, mediaType }
  } catch {
    return undefined
  }
}

/** 需要"before/after 快照"的文件变更类工具。 */
export const AGY_FILE_MUTATION_TOOLS: ReadonlySet<string> = new Set(['write_to_file', 'replace_file_content'])

/**
 * 从 AGY 工具参数里取目标文件路径(view_file=AbsolutePath;write/edit=TargetFile)。
 * @param params - AGY 工具参数(键为 PascalCase,另有少量 snake_case 兼容)。
 * @returns 路径字符串;缺失返回 undefined。
 */
export function agyToolFilePath(params: Record<string, unknown> | undefined): string | undefined {
  if (params === undefined) return undefined
  const value = params['TargetFile'] ?? params['AbsolutePath'] ?? params['file_path']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 读取文件原始文本(有界);不存在/超限/不可读返回 undefined。
 * @param filePath - 绝对路径(AGY 参数里的 TargetFile/AbsolutePath)。
 */
export function readFileRaw(filePath: unknown): string | undefined {
  if (typeof filePath !== 'string' || filePath.length === 0) return undefined
  try {
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_READ_BYTES) return undefined
    return readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 文件头部预览:行号格式(`   1→内容`),最多 PREVIEW_LINES 行;超出行数时附总数注记。
 * @param filePath - 绝对路径。
 * @returns 预览文本;不可读返回 undefined。
 */
export function readFilePreview(filePath: unknown): string | undefined {
  const raw = readFileRaw(filePath)
  if (raw === undefined) return undefined
  const lines = raw.split(/\r?\n/)
  const shown = lines.slice(0, PREVIEW_LINES)
  const width = String(lines.length).length
  const body = shown
    .map((line, index) => `${String(index + 1).padStart(width)}→${line}`)
    .join('\n')
  const tail = lines.length > PREVIEW_LINES ? `\n… (共 ${lines.length} 行,以上为前 ${PREVIEW_LINES} 行)` : ''
  return body + tail
}

/**
 * before/after 行级差异:裁公共前后缀,变更区带少量上下文,输出 `- / +` 行。
 * 完全一致或任一快照缺失时返回 undefined。
 * @param before - 变更前文本(工具开始时的快照)。
 * @param after - 变更后文本(工具结束时的读取)。
 * @returns 紧凑 diff 文本;无差异/不可比对返回 undefined。
 */
export function diffLineSnapshots(before: string | undefined, after: string | undefined): string | undefined {
  if (before === undefined || after === undefined || before === after) return undefined
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1 }
  const width = String(Math.max(a.length, b.length)).length
  const lines: string[] = []
  // 变更前上下文:start 之前的几行(两侧相同,取 before 侧)。
  for (let i = Math.max(0, start - DIFF_CONTEXT_LINES); i < start; i += 1) {
    lines.push(`  ${String(i + 1).padStart(width)}│${a[i]}`)
  }
  // 删除行(a[start..endA])与新增行(b[start..endB])。
  for (let i = start; i <= endA; i += 1) lines.push(`- ${String(i + 1).padStart(width)}│${a[i]}`)
  for (let i = start; i <= endB; i += 1) lines.push(`+ ${String(i + 1).padStart(width)}│${b[i]}`)
  // 变更后上下文:endB 之后的几行。
  for (let i = endB + 1; i < Math.min(b.length, endB + 1 + DIFF_CONTEXT_LINES); i += 1) {
    lines.push(`  ${String(i + 1).padStart(width)}│${b[i]}`)
  }
  if (lines.length > DIFF_MAX_LINES) {
    lines.length = DIFF_MAX_LINES
    lines.push('… (差异过长,已截断)')
  }
  return lines.join('\n')
}

/**
 * 按工具名补全结果文本:读文件附加预览,写/编辑附加 diff。
 * @param toolName - AGY 工具名。
 * @param filePath - 目标文件路径(来自工具参数)。
 * @param before - 变更前快照(仅文件变更类工具;未快照到为 undefined)。
 * @returns 追加补全后的文本;无补全时原样返回。
 */
export function enrichAgyToolResult(toolName: string, filePath: unknown, before?: string): string | undefined {
  if (toolName === 'view_file') return readFilePreview(filePath)
  if (AGY_FILE_MUTATION_TOOLS.has(toolName)) return diffLineSnapshots(before, readFileRaw(filePath))
  return undefined
}

/**
 * AGY 大输出落盘代读。
 *
 * AGY 对超过阈值(实测约 6KB)的工具输出**不给内容**:落盘到
 * `brain/<conversationId>/.system_generated/steps/<stepIndex>/output.txt`,只在
 * 模型可见文本里留时间戳+路径;llm-agy 拿到的 `tool_info.output` 是空。适配器
 * 按约定路径代读,把内容补进 tool/result——否则 dsh 会话与工具卡片只剩空结果
 * (实测:skill 加载 6KB 全量落盘;模型试图用 read 读回时,读取结果**又被落盘**,
 * 形成"读也读不回"的死循环,最终只能放弃并复述)。
 * @param conversationId - AGY 会话 id(落盘目录名,来自 init 事件)。
 * @param stepIndex - 工具步骤索引(落盘子目录名,与事件 step_index 同源)。
 * @returns 落盘文本;不存在/不可读/为空返回 undefined。
 */
export function readSavedToolOutput(conversationId: string, stepIndex: number): string | undefined {
  const file = join(homedir(), '.gemini', 'antigravity-cli', 'brain', conversationId,
    '.system_generated', 'steps', String(stepIndex), 'output.txt')
  try {
    const raw = readFileSync(file, 'utf8')
    return raw.length > 0 ? raw : undefined
  } catch {
    return undefined
  }
}
