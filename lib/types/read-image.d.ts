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
import type { Context } from '@deepseek-ai/cordis';
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
export declare function agyReadImage(command: string, proxy: string, filePath: string, extra?: string, signal?: AbortSignal): Promise<string>;
/** UI 呈现用的附件引用字段(saveImage 返回的可 JSON 化子集)。 */
export type ImageRefValue = {
    attachmentId: string;
    mediaType: string;
    bytes: number;
    width: number;
    height: number;
    name?: string;
    originalDimensions?: {
        width: number;
        height: number;
    };
};
/** 本工具用到的附件服务面(只读所需字段;服务可能未挂载)。 */
export interface AttachmentsFace {
    readImage?: (ref: unknown, signal?: AbortSignal) => Promise<{
        data: Uint8Array;
        mediaType?: string;
    }>;
    saveImage?: (input: {
        data: Uint8Array;
        mediaType: string;
        name?: string;
    }) => Promise<ImageRefValue>;
    imageLimits?: {
        maxImageBytes?: number;
    };
}
/**
 * 把图片字节提交到附件存储,供工具卡片渲染图片画廊(纯 UI 呈现:
 * 模型可见内容不变,仍是纯文本描述——文本模型路由不会被图片块破坏)。
 * 失败跳过不影响读图结果;跳过原因落 console.warn(可在 dsh stderr 日志查)。
 */
export declare function commitImagePresentation(attachments: AttachmentsFace | undefined, data: Uint8Array, mediaType: string, name?: string): Promise<ImageRefValue | undefined>;
/** 生成 `read_image_agy` 工具定义(全局常驻,独立命名)。
 * @param getOptions - 读当前生效的 AGY 命令与代理。
 * @param getAttachments - 取附件服务(呈现/粘贴引用路径用);未注入或未挂载时
 *   返回 undefined,仅失去画廊与粘贴引用能力,核心读图不受影响。
 */
export declare function agyReadImageAgyTool(getOptions: () => {
    command: string;
    proxy: string;
}, getAttachments?: () => AttachmentsFace | undefined): import("@deepseek-ai/dsh-tools").ToolDefinition;
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
export declare function captureAttachments(ctx: Context): () => AttachmentsFace | undefined;
/** 注册 read_image_agy 工具(全局常驻),返回注销函数。
 *
 * 附件服务经 {@link captureAttachments} 捕获;服务缺席时工具照常注册,仅失去
 * 画廊/粘贴引用能力。
 */
export declare function registerReadImageAgy(ctx: Context, getOptions: () => {
    command: string;
    proxy: string;
}): (() => void) | undefined;
