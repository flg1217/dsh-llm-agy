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
import { runAgyText } from './agy-run.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
/**
 * AGY 读图:同步执行,返回描述文本。
 * @param extra - 调用方对看图方式的额外要求(可选),拼进提示词尾部;
 *   例如"只提取表格里的数字"、"重点说明布局结构"。省略时为通用详细描述。
 */
/**
 * AGY 读图:执行一次完整 AGY 调用,返回描述文本。
 * 超时预算按"读图是短任务"收紧:空闲 60s 无输出即判卡死、总时长 3 分钟软上限
 * (公共执行器默认是 60s / 10 分钟)。读图期间 AGY 持续输出即续命,不会被
 * 固定时长误杀。
 * @param extra - 调用方对看图方式的额外要求(可选),拼进提示词尾部;
 *   例如"只提取表格里的数字"、"重点说明布局结构"。省略时为通用详细描述。
 */
export async function agyReadImage(command, proxy, filePath, extra) {
    const focus = extra === undefined || extra.trim().length === 0
        ? ''
        : `

看图要求:${extra.trim()}`;
    // 无额外要求时保持原有提示词一字不变(中继结果按附件缓存,措辞即内容)。
    const prompt = focus.length === 0
        ? `请查看这张图片并描述你看到的内容:${filePath}。给出准确、详细的中文描述,回答问题时直接依据图片内容。`
        : `请查看这张图片:${filePath}。给出准确、详细的中文描述,回答问题时直接依据图片内容。${focus}`;
    const text = (await runAgyText({
        command,
        prompt,
        proxy,
        timeouts: { idleMs: 60_000, totalMs: 180_000 },
    })).trim();
    if (text.length === 0)
        throw new Error('AGY 读图无输出');
    return text;
}
/** 图片媒体类型 → 扩展名。 */
function extensionOf(mediaType) {
    switch (mediaType) {
        case 'image/png': return 'png';
        case 'image/jpeg': return 'jpg';
        case 'image/gif': return 'gif';
        case 'image/webp': return 'webp';
        default: return 'img';
    }
}
/** 从 file_path 解析附件引用:
 * - JSON(完整 ImageAttachmentRef)→ 解析为 ref(可读);
 * - /describe-image/raw/<id> 或纯 id → 仅 attachmentId(缺 metadata 校验,
 *   attachment 服务会拒绝;仅供错误提示)。
 */
function attachmentRefFrom(filePath) {
    const trimmed = filePath.trim();
    if (trimmed.length === 0 || trimmed.length > 4096)
        return undefined;
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed?.attachmentId === 'string' && parsed.attachmentId.length > 0)
                return parsed;
        }
        catch { /* 非 JSON,继续其它匹配 */ }
    }
    const rawMatch = /\/raw\/([^/?#]+)$/.exec(trimmed);
    if (rawMatch !== null)
        return { attachmentId: rawMatch[1] };
    if (/^[A-Za-z0-9:_-]+$/.test(trimmed) && !trimmed.includes('/') && !trimmed.includes('\\')) {
        return { attachmentId: trimmed };
    }
    return undefined;
}
/**
 * 按附件引用读图:通过 attachment 服务读字节 → 临时文件 → AGY 读图。
 * 返回描述文本;无法解析/读取失败返回 undefined。
 */
async function readImageByAttachment(ctx, filePath, command, proxy, extra) {
    const ref = attachmentRefFrom(filePath);
    if (ref === undefined)
        return undefined;
    const attachments = ctx.get('attachments');
    if (!attachments?.readImage)
        return undefined;
    let out;
    try {
        out = await attachments.readImage(ref);
    }
    catch (error) {
        // 附件读取失败:显式抛出,便于诊断(不再静默回退)。
        throw new Error(`read_image_agy: 附件读取失败: ${String(error)}`);
    }
    if (out === undefined || out.data.byteLength === 0)
        return undefined;
    // 写系统临时文件(不落工作区),AGY 读完后立即清理。
    const dir = mkdtempSync(join(tmpdir(), 'agy-read-image-'));
    const mediaType = out.mediaType ?? 'image/png';
    const ext = extensionOf(mediaType);
    const tmp = join(dir, `image.${ext}`);
    try {
        writeFileSync(tmp, out.data);
        return await agyReadImage(command, proxy, tmp, extra);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
/** 生成 `read_image_agy` 工具定义(全局常驻,独立命名)。 */
export function agyReadImageAgyTool(ctx, getOptions) {
    return defineTool({
        name: 'read_image_agy',
        description: 'Read a PNG/JPEG/WebP/GIF file and describe its content (via AGY/Gemini vision). '
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
            render: (_args, value) => [{
                    type: 'text',
                    text: `<path>${value.path}</path>\n<content>${value.description}</content>`,
                }],
        },
        // 读图只读无副作用,且 AGY 支持并发调用——允许模型同时发的多个读图并行执行,
        // 避免第二个调用在第一个(可能 20~70s)后面白白排队。
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const filePath = args.file_path;
            if (typeof filePath !== 'string' || filePath.trim().length === 0) {
                throw new Error('file_path must be a non-empty string');
            }
            const { command, proxy } = getOptions();
            // 额外看图要求(可选):非空才拼进提示词。
            const raw = args.prompt;
            const extra = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
            // 1) 磁盘路径:先按原样读;相对路径用会话工作目录解析
            //    (与官方 tool-fs 一致:exec.agent.session.header.cwd;服务进程 cwd
            //    不是项目根,不解析的话模型发的 `Frontend/.temp/x.png` 会直接失败)。
            let diskPath = filePath;
            if (!existsSync(diskPath) && !isAbsolute(diskPath)) {
                const sessionCwd = exec?.agent?.session?.header?.cwd;
                if (sessionCwd !== undefined && existsSync(join(sessionCwd, diskPath))) {
                    diskPath = join(sessionCwd, diskPath);
                }
            }
            if (existsSync(diskPath)) {
                const description = await agyReadImage(command, proxy, diskPath, extra);
                return { path: diskPath, description };
            }
            // 2) 附件引用(粘贴图片):attachment 服务读字节 → 临时文件 → AGY 读图。
            const byAttachment = await readImageByAttachment(ctx, filePath, command, proxy, extra);
            if (byAttachment !== undefined) {
                return { path: filePath, description: byAttachment };
            }
            throw new Error(`cannot read "${filePath}": no such file (not a local path or a known attachment id)`);
        },
    });
}
/** 注册 read_image_agy 工具(全局常驻),返回注销函数。 */
export function registerReadImageAgy(ctx, getOptions) {
    try {
        return ctx.tools.register(agyReadImageAgyTool(ctx, getOptions));
    }
    catch {
        /* 已注册则跳过 */
        return undefined;
    }
}
