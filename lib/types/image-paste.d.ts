/**
 * Image relay(后端输入后处理):让文本主模型(如 DeepSeek V4 Flash)支持"输入栏贴图"。
 *
 * 模式:纯插件内、用户完全无感——不新增 provider 路由、不改模型路由、
 * 不改前端、不修改任何其它插件、不改 dsh 源码。
 *
 * 处理策略:**只消费最新一条用户输入**。
 * - dsh 的请求是无状态的,每轮都从会话事件重建完整历史,历史里的图片块会在
 *   每个请求里反复出现——只把"最新一条用户输入"里的图片物化为路径文本,
 *   历史消息里的图片块在请求级直接丢弃(不落盘、不转换、不写会话日志),
 *   因此同一张图永远不会被重复消费,也不会堆积重复文件。
 * - 同一轮内的多次请求(工具调用后继续)会再次处理同一条最新输入,靠
 *   附件级缓存复用同一路径,不产生新文件。
 *
 * 两个环节:
 *   1. 包装 llm.resolveModelInfo:文本模型被声明为支持 image 输入
 *      (记录在 imageDeclared 集合)——绕过 api-proxy 的
 *      MODEL_DOES_NOT_SUPPORT_IMAGES 拒绝;
 *   2. llm/stream waterfall 监听器:仅对 imageDeclared 中的模型,把
 *      最新用户输入里的 ImageBlock 从 attachment 读字节 → 落盘到工作区
 *      .dsh-llm-agy/tmp/pasted-images/ → 替换为"[图片已保存到 <路径>]"文本
 *      → 接管调用原 adapter.stream(文本模型收到路径文本);
 *   3. 主代理调用 read_image(AGY 版)或 subagent_agy_ui 看图。
 * @module llm-agy/image-paste
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm';
/** 读 attachment 图片字节并落盘到工作区,返回绝对路径(同一附件同会话只写一次)。 */
export declare function materializeImage(ctx: Context, block: Extract<ContentBlock, {
    type: 'image';
}>, sessionId: string | undefined): Promise<string>;
/**
 * 转换请求消息:**只消费最新一条用户输入**。
 *
 * - 最新一条 user 消息里的 ImageBlock:物化落盘 + 替换为路径提示文本;
 * - 更早的 user 消息里的 ImageBlock(历史重放):请求级直接丢弃,不落盘、
 *   不转换、不写会话日志——同一张图永远不会被重复消费;
 * - 历史图片消息丢弃后无剩余内容时,整条从请求中移除。
 *
 * 完全不改动会话数据(日志、surface 都不碰)。
 */
export declare function convertPastedImages(ctx: Context, messages: readonly Message[], sessionId?: string): Promise<Message[]>;
/**
 * 安装图片中继:
 * 1. 包装 llm.resolveModelInfo,把文本模型声明为支持 image(绕过 api-proxy 拒绝);
 * 2. llm/stream 监听器对声明过的模型转换 ImageBlock。
 */
export declare function installImageRelay(ctx: Context): void;
