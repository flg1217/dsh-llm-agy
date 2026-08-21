/**
 * AGY 可用模型查询工具。
 *
 * AGY CLI 自带 `models` 子命令,输出 `id\t名称` 逐行(stdout);
 * "Fetching available models..." 等提示走 stderr,不影响解析。
 * 主代理先查询再以准确的 model id 委派。
 * @module llm-agy/models
 */
import type { Context } from '@deepseek-ai/cordis';
/** 解析 `agy models` 输出,返回模型 id + 名称列表文本。 */
export declare function listAgyModels(command: string): string;
/** 注册模型查询工具(与 subagent_agy_ui 配套)。 */
export declare function registerAgyModelsTool(ctx: Context, options: {
    command: string;
    toolName: string;
}): void;
