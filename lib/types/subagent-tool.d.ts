/**
 * 自定义子代理委派工具(替代 @deepseek-ai/dsh-tool-subagent 挂载)。
 *
 * 在工具描述里内置"完整上下文"指引:子代理看不到当前会话、无法追问,
 * 每次委派必须自带全部上下文(目标/验收标准/路径/约束/输出格式)。
 * 机制与 dsh-tool-subagent 相同:continuable 后台优先 + 前台回退。
 * @module llm-agy/subagent-tool
 */
import type { Context } from '@deepseek-ai/cordis';
/** 委派工具配置。 */
export interface SubagentToolOptions {
    /** ctx.subagents 提供方名(本插件固定 spawn)。 */
    provider: string;
    /** 模型可见工具名。 */
    toolName: string;
    /** 子代理的模型路由(provider + model)。 */
    agentOptions: {
        provider: string;
        model: string;
    };
    /** 工具描述(模型可见),已含完整上下文指引。 */
    description: string;
    /** prompt 参数描述。 */
    promptDescription: string;
}
/** 注册自定义子代理委派工具(continuable,后台优先)。 */
export declare function registerSubagentTool(ctx: Context, options: SubagentToolOptions): void;
