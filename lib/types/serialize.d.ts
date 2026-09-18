/**
 * 序列化模块:把 dsh 消息翻译为 AGY 单轮 prompt。
 * - 系统提示(可选)、对话消息按顺序拼接为文本;
 * - 图片块落盘为临时文件,在 prompt 中给出本地路径(AGY 自行读取看图);
 * - 超长 prompt 写入临时文件,命令行只给短引用(Windows 命令行 32K 限制);
 * - 续聊补发(`resumeReplayPrompt`):从发送锚点切片,把 AGY conversation
 *   尚未见过的消息补上,同时跳过 AGY 自己产生的轮次(其会话里已有)。
 *   算法与 dsh-subagent-codebuddy 的 dsh↔CodeBuddy 转换模块同源,差异:
 *   AGY 有自己的服务端 conversation 上下文,锚点丢失/压缩时**不整体重发**
 *   (重复内容膨胀且会被当作新任务从头重跑),只用最后一条用户输入兜底。
 * - 运行时约束:AGY 是一次性 print 进程,回合结束即终止,后台任务唤醒
 *   循环不存在——每次 prompt 都显式禁止后台任务。
 * @module llm-agy/serialize
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
/** 续跑兜底:仅当没有可补发内容时使用。 */
export declare const CONTINUE_PROMPT = "\u7EE7\u7EED\u5B8C\u6210\u4E4B\u524D\u672A\u5B8C\u6210\u7684\u4EFB\u52A1\u3002\u57FA\u4E8E\u5F53\u524D\u5DE5\u4F5C\u533A\u72B6\u6001\u7EE7\u7EED,\u4E0D\u8981\u91CD\u590D\u5DF2\u5B8C\u6210\u7684\u5DE5\u4F5C,\u53EA\u62A5\u544A\u65B0\u505A\u7684\u5185\u5BB9\u3002";
/** 序列化结果:prompt 文本 + 资源清理。 */
export interface SerializedPrompt {
    prompt: string;
    cleanup: () => Promise<void>;
}
/** 首轮全量序列化(system + 消息)。仅当本 dsh 会话没有 AGY conversation 记忆时使用。 */
export declare function buildPrompt(ctx: Context, options: GenerateOptions): Promise<SerializedPrompt>;
/**
 * 续聊兜底:只发**用户自己发的**最后一条消息(锚点缺失/历史被压缩收缩时)。
 *
 * 必须按 `source.kind === 'user'` 精确取:插件注入的上下文(系统提醒、
 * 工作区指令、技能目录)同样是 user 角色、且排在用户消息**之后**,
 * 按"最后一条 user 角色"取会把用户输入整条顶掉——实测:压缩完成后
 * 被 claim 的排队消息丢失,模型只看到技能目录提醒。
 */
export declare function lastUserPrompt(ctx: Context, messages: readonly Message[]): Promise<SerializedPrompt>;
/**
 * 续聊补发:把"AGY conversation 尚未见过"的消息补发给 AGY。
 *
 * 主锚是**消息 id**(`lastSentMessageId`):上次发送覆盖到的最后一条消息。
 * 数量锚(`sentCount`)在历史被压缩/编辑后不可靠。锚点找不到(已被压缩
 * 移除)或数量锚不可信(越界/已发区内出现压缩 checkpoint)时,**不做整体
 * 重发**——AGY 服务端 conversation 有自己的完整上下文,重发会重复膨胀且被
 * 当作新任务从头重跑(实测);只补发最后一条用户输入兜底,保证最新指令必达。
 *
 * 补发按 User/Assistant 序列化;AGY 自己产生的消息(assistant/tool)跳过,
 * 其他模型轮次与用户输入完整补上。
 * @param ctx - 插件上下文(读取附件服务)。
 * @param messages - 当前 dsh 折叠视图的完整消息序列。
 * @param sentCount - 旧的数量锚(仅兼容历史记录;新锚见下)。
 * @param lastSentMessageId - 上次发送覆盖到的最后一条消息 id(主锚,可选)。
 * @param ownProvider - "本端"provider 名(其 assistant 轮次已在 AGY 历史里)。
 */
export declare function resumeReplayPrompt(ctx: Context, messages: readonly Message[], sentCount: number | undefined, lastSentMessageId?: string, ownProvider?: string): Promise<SerializedPrompt>;
