/**
 * 序列化模块:把 harness GenerateOptions 翻译为 AGY 单轮 prompt。
 * 对齐 llm-deepseek/serialize.ts 的职责:请求 → 上游格式。
 * - 系统提示、对话消息按顺序拼接;
 * - 图片块落盘为临时文件,在 prompt 中给出本地路径(AGY 自行读取看图);
 * - 超长 prompt 写入临时文件,命令行只给短引用(Windows 命令行 32K 限制)。
 * @module llm-agy/serialize
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
/** 序列化结果:prompt 文本 + 资源清理。 */
export interface SerializedPrompt {
    prompt: string;
    cleanup: () => Promise<void>;
}
/** 把 harness 消息序列化为 AGY 单轮 prompt;图片落盘为临时路径。 */
export declare function buildPrompt(ctx: Context, options: GenerateOptions): Promise<SerializedPrompt>;
