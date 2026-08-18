/**
 * Image relay(后端输入后处理):让文本主模型(如 DeepSeek V4 Flash)支持"输入栏贴图"。
 *
 * 模式:纯插件内、用户完全无感——不新增 provider 路由、不改模型路由、
 * 不改前端、不修改任何其它插件、不改 dsh 源码。
 *
 * 两个环节:
 *   1. 包装 llm.resolveModelInfo:文本模型被声明为支持 image 输入
 *      (记录在 imageDeclared 集合)——绕过 api-proxy 的
 *      MODEL_DOES_NOT_SUPPORT_IMAGES 拒绝;
 *   2. llm/stream waterfall 监听器:仅对 imageDeclared 中的模型,把
 *      ImageBlock 从 attachment 读字节 → 落盘到工作区
 *      .dsh-llm-agy/tmp/pasted-images/ → 替换为"[图片已保存到 <路径>]"文本
 *      → 接管调用原 adapter.stream(文本模型收到路径文本);
 *      同时把会话 surface 里那条 user/message 事件改写为路径文本——
 *      图片只消费一次,后续请求从 surface 构建历史时根本不再包含图片。
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
 * 源头根治:改写会话的模型可见历史(surface)。
 *
 * dsh 的请求是无状态的——每个请求都从会话事件重建完整消息历史,粘贴图片的那条
 * user/message 事件始终带着 ImageBlock,所以若不处理,图片会在每个请求里被
 * 重新消费(重放)。这里把仍带 ImageBlock 的 user/message 事件改写为路径文本:
 * surface 替换只影响模型可见层(人工转录保持原样,UI 里的图片还在),改写后
 * 后续请求从 surface 构建历史时根本不再包含图片,不存在重放。
 *
 * 幂等:日志里已有覆盖该 seq 的替换事件时跳过,进程重启后也不会重复改写。
 */
export declare function rewritePastedImageEvents(ctx: Context, sessionId: string | undefined): Promise<void>;
/** 转换消息:ImageBlock → 路径文本;返回新消息数组。 */
export declare function convertPastedImages(ctx: Context, messages: readonly Message[], sessionId?: string): Promise<Message[]>;
/**
 * 安装图片中继:
 * 1. 包装 llm.resolveModelInfo,把文本模型声明为支持 image(绕过 api-proxy 拒绝);
 * 2. llm/stream 监听器对声明过的模型转换 ImageBlock。
 */
export declare function installImageRelay(ctx: Context): void;
