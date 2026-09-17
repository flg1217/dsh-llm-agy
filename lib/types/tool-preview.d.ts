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
/** 扩展名 → 图片媒体类型(声明用途;真实格式由魔数嗅探兜底)。 */
export declare const IMAGE_MEDIA_BY_EXT: Readonly<Record<string, string>>;
/** 图片魔数嗅探:扩展名缺失或不可信时判定真实格式。 */
export declare function sniffImageMediaType(data: Uint8Array): string | undefined;
/**
 * 读取图片文件字节(限额内)。view_file 读到的是图片时,适配器走"图片块"
 * 通道(会话附件授权 + UI 画廊),而不是把二进制当文本预览。
 * @param filePath - 绝对路径。
 * @param maxBytes - 字节上限(默认 20MB)。
 * @returns 字节与媒体类型;非图片/超限/不可读返回 undefined。
 */
export declare function readImageFile(filePath: unknown, maxBytes?: number): {
    data: Uint8Array;
    mediaType: string;
} | undefined;
/** 需要"before/after 快照"的文件变更类工具。 */
export declare const AGY_FILE_MUTATION_TOOLS: ReadonlySet<string>;
/**
 * 从 AGY 工具参数里取目标文件路径(view_file=AbsolutePath;write/edit=TargetFile)。
 * @param params - AGY 工具参数(键为 PascalCase,另有少量 snake_case 兼容)。
 * @returns 路径字符串;缺失返回 undefined。
 */
export declare function agyToolFilePath(params: Record<string, unknown> | undefined): string | undefined;
/**
 * 读取文件原始文本(有界);不存在/超限/不可读返回 undefined。
 * @param filePath - 绝对路径(AGY 参数里的 TargetFile/AbsolutePath)。
 */
export declare function readFileRaw(filePath: unknown): string | undefined;
/**
 * 文件头部预览:行号格式(`   1→内容`),最多 PREVIEW_LINES 行;超出行数时附总数注记。
 * @param filePath - 绝对路径。
 * @returns 预览文本;不可读返回 undefined。
 */
export declare function readFilePreview(filePath: unknown): string | undefined;
/**
 * before/after 行级差异:裁公共前后缀,变更区带少量上下文,输出 `- / +` 行。
 * 完全一致或任一快照缺失时返回 undefined。
 * @param before - 变更前文本(工具开始时的快照)。
 * @param after - 变更后文本(工具结束时的读取)。
 * @returns 紧凑 diff 文本;无差异/不可比对返回 undefined。
 */
export declare function diffLineSnapshots(before: string | undefined, after: string | undefined): string | undefined;
/**
 * 按工具名补全结果文本:读文件附加预览,写/编辑附加 diff。
 * @param toolName - AGY 工具名。
 * @param filePath - 目标文件路径(来自工具参数)。
 * @param before - 变更前快照(仅文件变更类工具;未快照到为 undefined)。
 * @returns 追加补全后的文本;无补全时原样返回。
 */
export declare function enrichAgyToolResult(toolName: string, filePath: unknown, before?: string): string | undefined;
