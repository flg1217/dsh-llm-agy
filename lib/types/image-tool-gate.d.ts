/**
 * 读图工具闸门(按模型模态分流)。
 *
 * 两条对称规则:
 * - **仅文本**(或能力未知)路由 → 禁 dsh 原生 `read_image`、指路 `read_image_agy`。
 *   原因:原生 read_image 要求模型声明图片输入,而 relay 为了让文本模型能用它
 *   会把模型伪声明为支持 image——于是调用成功、图片块进历史,下一次请求才被
 *   适配器硬拒(`pi-ai model "X" does not support image input`)。
 * - **多模态**路由 → 禁 `read_image_agy`、指路 `read_image`。AGY 的文字转述对
 *   能直接看图的模型是纯损失(细节丢失),图片本身进上下文才是正解。
 *
 * **真值判定只用 `imageCapable` 集合**(relay 包装器按原生声明填充),
 * **不看 `resolveModelInfo` 的返回值**——relay 会把纯文本路由伪声明成支持
 * image(image-paste.ts 的包装),拿返回值判会让两条规则全部失效。
 * 集合未命中时先探测一次(探测顺带填充集合),再查集合。
 *
 * 两条规则都可被设置里的「按模型模态分流读图工具」总开关关掉(关掉后只靠
 * 提示词引导,不硬拒)。
 * @module llm-agy/image-tool-gate
 */
import type { Context } from '@deepseek-ai/cordis';
/** 一次工具调用路由到的模型(provider + model)。 */
export interface RoutedModel {
    provider: string;
    model: string;
}
/**
 * 从 `tools/pre-execute` 的 exec 上取本次调用的路由模型。
 * 会话级选择(`session.requestHeader().config`)优先,回退 agent 默认 options。
 * @param exec - 工具执行上下文(只读所需字段)。
 * @returns 路由;两处都取不到时 undefined。
 */
export declare function routedModelOf(exec: unknown): RoutedModel | undefined;
/**
 * 真·多模态判定:只认 `imageCapable` 集合(原生声明)。
 * 未命中时探测一次 `resolveModelInfo`(探测顺带填充集合),再查集合;
 * **不使用探测返回值**(relay 伪声明会让它恒真)。
 * @param ctx - 插件上下文(取 llm 服务)。
 * @param target - 路由模型。
 * @returns 是否原生支持图片输入。
 */
export declare function routeIsImageCapable(ctx: Context, target: RoutedModel): Promise<boolean>;
/**
 * 安装读图工具闸门(幂等注册一次,内部每次调用热读开关)。
 * @param ctx - 插件上下文。
 * @param enabled - 读当前设置(每次调用求值,设置面板切换后即时生效)。
 * @returns 注销函数。
 */
export declare function installImageToolGate(ctx: Context, enabled: () => boolean): () => void;
