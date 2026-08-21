/**
 * 自定义子代理委派工具(替代 @deepseek-ai/dsh-tool-subagent 挂载)。
 *
 * 在工具描述里内置"完整上下文"指引:子代理看不到当前会话、无法追问,
 * 每次委派必须自带全部上下文(目标/验收标准/路径/约束/输出格式)。
 * 机制与 dsh-tool-subagent 相同:continuable 后台优先 + 前台回退。
 * @module llm-agy/subagent-tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
/** Prompt order after bounded delegation policy and before child reporting. */
const SECTION_ORDER = 116.5;
/** 渲染文本块。 */
function outputValueText(values) {
    return values
        .filter((value) => typeof value === 'object' && value !== null && !Array.isArray(value)
        && value.type === 'text' && typeof value.text === 'string')
        .map(value => value.text)
        .join('');
}
/** 非 completed 停止原因 → 错误文案。 */
function stopReasonError(result) {
    switch (result.stopReason) {
        case 'completed': return undefined;
        case 'aborted': return 'subagent run was cancelled';
        case 'error': return 'subagent run failed';
        case 'max-tokens': return 'subagent run hit its token limit before finishing';
        case 'refusal': return 'subagent declined the task';
        default: return `subagent run ended abnormally (${String(result.stopReason)})`;
    }
}
/** 失败时附上子代理已产出的部分文本。 */
function withPartialText(error, output) {
    const text = output
        .filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('');
    return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`;
}
/** 收集并释放一次前台 run。 */
async function settleForeground(run) {
    try {
        const result = await run.result;
        const error = stopReasonError(result);
        if (error !== undefined) {
            throw new Error(withPartialText(error, result.output));
        }
        return {
            kind: 'foreground',
            runId: run.id,
            output: result.output,
        };
    }
    finally {
        await run.dispose();
    }
}
/** 注册自定义子代理委派工具(continuable,后台优先)。 */
export function registerSubagentTool(ctx, options) {
    const { provider, toolName, agentOptions } = options;
    ctx.tools.register(defineTool({
        name: toolName,
        description: options.description,
        parameters: {
            description: {
                type: 'string',
                required: true,
                description: 'A short (3-5 word) description of the delegated task, for display.',
            },
            prompt: {
                type: 'string',
                required: true,
                description: options.promptDescription,
            },
            run_in_background: {
                type: 'boolean',
                description: 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.',
            },
            model: {
                type: 'string',
                description: 'Optional model ID for the subagent. Query the model list tool (e.g. list_agy_models) for the currently supported ids and pass an exact one; omit to use the plugin-configured default model.',
            },
        },
        output: {
            schema: {
                oneOf: [
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            kind: { type: 'string', required: true, const: 'continuable' },
                            subagentId: { type: 'string', required: true },
                        },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            kind: { type: 'string', required: true, const: 'foreground' },
                            runId: { type: 'string', required: true },
                            output: { type: 'array', required: true, items: { type: 'json' } },
                        },
                    },
                ],
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.kind === 'continuable'
                        ? `started subagent ${value.subagentId}`
                        : outputValueText(value.output),
                }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const parent = exec.agent;
            if (!parent) {
                throw new Error('subagent tool requires a calling agent (exec.agent was undefined)');
            }
            const request = {
                label: args.description,
                prompt: [{ type: 'text', text: args.prompt }],
                parent,
                agentOptions: args.model !== undefined && args.model.length > 0
                    ? { ...agentOptions, model: args.model }
                    : agentOptions,
            };
            if (args.run_in_background !== false) {
                const started = await ctx.subagents.startContinuable({
                    provider,
                    label: args.description,
                    request,
                    signal: exec.signal,
                });
                return { kind: 'continuable', subagentId: started.childId };
            }
            const run = await ctx.subagents.start(provider, {
                ...request,
                signal: exec.signal,
            });
            return await settleForeground(run);
        },
    }));
    ctx.systemPrompt.section({
        name: `tool:${toolName}`,
        order: SECTION_ORDER,
        text: context => ctx.tools.get(toolName, context.scope) === undefined
            ? ''
            : `Use ${toolName} in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message. To use a non-default model, first query the model list tool for a supported id and pass that exact id in the \`model\` argument.`,
    });
}
