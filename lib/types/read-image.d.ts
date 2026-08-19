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
/** AGY 读图:同步执行,返回描述文本。 */
export declare function agyReadImage(command: string, proxy: string, filePath: string): string;
/** 生成 `read_image_agy` 工具定义(全局常驻,独立命名)。 */
export declare function agyReadImageAgyTool(ctx: Context, getOptions: () => {
    command: string;
    proxy: string;
}): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** 注册 read_image_agy 工具(全局常驻),返回注销函数。 */
export declare function registerReadImageAgy(ctx: Context, getOptions: () => {
    command: string;
    proxy: string;
}): (() => void) | undefined;
