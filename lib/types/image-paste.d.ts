/**
 * Image relay(后端输入后处理):让文本主模型(如 DeepSeek V4 Flash)支持"输入栏贴图"。
 *
 * 模式:纯插件内、用户完全无感——不新增 provider 路由、不改模型路由、
 * 不改前端、不修改任何其它插件、不改 dsh 源码。**不写工作区磁盘**。
 *
 * 处理策略(参考 dsh-vision-toolkit 的 stream 就地读图):
 * - llm/stream 监听器转换 ImageBlock 时,**就地读图并生成描述文本**进消息:
 *   attachment 服务按完整 ref 读字节 → 临时文件(系统 temp,用完即删)
 *   → AGY/Gemini 读图 → 替换为"[用户粘贴的图片内容: <AGY 描述>]"文本;
 *   主代理直接看到图片描述,**无需调用任何工具**。
 * - **缓存**:同一附件(内容寻址 attachmentId)只读图一次,后续请求从缓存取
 *   描述文本,保证确定性(网关 prompt 缓存命中)且不重复消耗 AGY。
 * - read_image_agy 工具保留:本地磁盘路径读图、以及附件引用的兜底读取。
 *
 * 两个环节:
 *   1. 包装 llm.resolveModelInfo:文本模型被声明为支持 image 输入
 *      (记录在 imageDeclared 集合)——绕过 api-proxy 的
 *      MODEL_DOES_NOT_SUPPORT_IMAGES 拒绝;
 *   2. llm/stream waterfall 监听器:仅对 imageDeclared 中的模型,把
 *      ImageBlock 就地读图生成描述文本 → 接管调用原 adapter.stream。
 * @module llm-agy/image-paste
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Message } from '@deepseek-ai/dsh-llm';
/** 该模型路由是否原生支持 image(由 resolveModelInfo 探测后填充)。 */
export declare function isImageCapableRoute(provider: string, model: string): boolean;
/**
 * 转换请求消息:把**所有**消息内容里的 ImageBlock(含 tool-result 嵌套)都
 * 转换为描述文本——文本模型(如 deepseek-v4-flash)的流式适配器会在序列化
 * 时硬拒裸图片块(`pi-ai model "X" does not support image input`),所以历史
 * 里的图片块也必须转走,不能原样透传。
 *
 * - 所有图片块(最新输入与历史)统一使用同一描述模板(带 AGY 描述);
 * - 转换是**确定性**的:同一附件永远映射到同一描述文本(内容寻址缓存),
 *   每次请求内容完全一致,网关 prompt 缓存照常命中;
 * - 同轮工具调用后的继续请求同样按此规则转换,内容保持与前序请求一致。
 *
 * 完全不改动会话数据(日志、surface 都不碰),只影响本次请求的负载。
 */
export declare function convertPastedImages(ctx: Context, messages: readonly Message[], getOptions: () => {
    command: string;
    proxy: string;
}): Promise<Message[]>;
/**
 * 安装图片中继(返回注销函数,关闭开关时可整体移除):
 * 1. 包装 llm.resolveModelInfo,把文本模型声明为支持 image(绕过 api-proxy 拒绝);
 * 2. llm/stream 监听器对声明过的模型,就地读图生成描述文本后接管原 adapter。
 */
export declare function installImageRelay(ctx: Context, getOptions: () => {
    command: string;
    proxy: string;
}): (() => void) | undefined;
