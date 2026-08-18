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
import type { Context } from '@deepseek-ai/cordis';
/** AGY 读图:同步执行,返回描述文本。 */
export declare function agyReadImage(command: string, proxy: string, filePath: string): string;
/** 生成 `read_image_agy` 工具定义(全局常驻,独立命名)。 */
export declare function agyReadImageAgyTool(getOptions: () => {
    command: string;
    proxy: string;
}): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** 注册 read_image_agy 工具(全局常驻),返回注销函数。 */
export declare function registerReadImageAgy(ctx: Context, getOptions: () => {
    command: string;
    proxy: string;
}): (() => void) | undefined;
