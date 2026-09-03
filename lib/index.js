/**
 * llm-agy 插件入口:注册 AGY(Antigravity CLI)模型适配器 + 搜索 provider。
 * 对齐 llm-deepseek/index.ts 的结构:Config 定义 + apply 注册 provider 路由。
 * @module llm-agy
 */
import z from '@deepseek-ai/schemastery';
import { AgyLlmAdapter } from './adapter.js';
import { AgySearchProvider } from './search.js';
import { readImageAgyEnabled, registerAgySettings } from './settings.js';
import { installImageRelay } from './image-paste.js';
import { registerReadImageAgy } from './read-image.js';
import { installDelegationGuide } from './delegate-guide.js';
import { registerSubagentTool } from './subagent-tool.js';
import { registerAgyModelsTool } from './models.js';
import { registerSearchWebAgy } from './search-web-agy.js';
export const name = 'llm-agy';
export const inject = ['llm', 'web', 'tools', 'subagents', 'systemPrompt'];
export const Config = z.object({
    command: z.string().default('agy'),
    model: z.string().default('gemini-3.7-flash-high'),
    effort: z.string().default('high'),
    extraArgs: z.array(z.string()).default([]),
    proxy: z.string().default('http://127.0.0.1:7890'),
    registerSubagentTools: z.boolean().default(true),
});
/** 子代理委派工具:前端/UI 走 AGY/Gemini,独立于主模型。看图已由 read_image_agy 取代,不再注册子代理。 */
function registerSubagentTools(ctx, model, command) {
    const agentOptions = { provider: 'agy', model };
    // 自定义注册委派工具(替代官方 dsh-tool-subagent),以便在工具描述里
    // 内置"完整上下文"指引;机制一致(continuable 后台 + 前台回退)。
    registerSubagentTool(ctx, {
        provider: 'spawn',
        toolName: 'subagent_agy_ui',
        agentOptions,
        description: 'Delegate a frontend/UI implementation task to an AGY/Gemini subagent (a separate agent driven by the '
            + 'Antigravity CLI) — UI design, styling research, visual implementation, screenshot verification — so it does '
            + 'not consume this conversation\'s context. The subagent returns its result, not its intermediate steps.\n\n'
            + 'Provide COMPLETE context for every delegation — the subagent does not see this conversation and cannot ask '
            + 'follow-up questions: (1) the goal and acceptance criteria; (2) exact file/directory paths to touch or inspect; '
            + '(3) constraints and boundaries (what NOT to do, what to preserve); (4) the expected output format. Split complex '
            + 'tasks into independent subagents and run them in parallel. '
            + 'This tool runs in the background by default: it immediately returns a durable subagent id and keeps the child '
            + 'conversation available for later turns; when the run settles, the runtime sends you a notice containing its '
            + 'outcome and any final assistant message. Set `run_in_background: false` only when your next action depends on '
            + 'receiving the result; `send_message` starts a later turn in the same child conversation. '
            + 'Optionally pass a `model` argument with an exact model id (query `list_agy_models` for the currently '
            + 'supported ids); omit it to use the plugin-configured default model.',
        promptDescription: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include '
            + 'everything it needs: the goal, acceptance criteria, exact file paths, constraints, and the expected output format.',
    });
    // 模型查询工具:委派前可先确认当前支持的模型 id。
    registerAgyModelsTool(ctx, { command, toolName: 'list_agy_models' });
}
export function apply(ctx, config) {
    // 设置面板先注册:后面 adapter / 搜索 / 看图都从它读,面板改动即时生效。
    const readSettings = registerAgySettings(ctx);
    /**
     * AGY 调用参数:优先设置面板 → 回退插件 config → 内建默认。
     *
     * 用 getter 而不是一次性取值,这样每次调用(而不是插件加载时)才求值,
     * 设置面板里改代理/模型不需要重启。注意用 `||` 而非 `??`:面板清空某项
     * 会得到空字符串,应视为"未配置"继续回退。
     */
    const agyOptions = {
        get command() { return readSettings().command || config.command || 'agy'; },
        get model() { return readSettings().model || config.model || 'gemini-3.7-flash-high'; },
        get effort() { return readSettings().effort || config.effort || 'high'; },
        get proxy() { return readSettings().proxy || config.proxy || 'http://127.0.0.1:7890'; },
    };
    ctx.llm.registerAdapter(['agy'], new AgyLlmAdapter(ctx, {
        command: agyOptions.command,
        model: agyOptions.model,
        effort: agyOptions.effort,
        extraArgs: config.extraArgs ?? [],
        proxy: agyOptions.proxy,
    }));
    // 子代理委派工具:前端/UI 设计(subagent_agy_ui,continuable 可复用长线会话),
    // 由 AGY/Gemini 驱动;看图不委派子代理(用全局 read_image_agy)。
    if (config.registerSubagentTools !== false) {
        registerSubagentTools(ctx, agyOptions.model, agyOptions.command);
    }
    // AGY 深度搜索工具(独立命名,不接入 ctx.web 搜索框架):不设工具级
    // 超时预算,由 AGY 执行器控制空闲超时(3 分钟无输出判卡死,不设总时长);
    // 不受系统 web_search 的 60s 限制。附系统提示引导模型网络调研用它。
    // 设置面板的 command/proxy 等改动经 agyOptions getter 即时生效。
    registerSearchWebAgy(ctx, () => new AgySearchProvider(agyOptions));
    // 注:read_image 覆盖由 router-agy 预设的 read-image-override.mjs
    // (agent 作用域同名注册 shadow 全局)实现,受 agy namespace 的
    // overrideReadImage 开关控制;此处无需注册。
    // 图片中继(AGY 就地读图):受 agy settings namespace 的 readImageAgy 开关控制
    // (默认开启)。关闭时不注入 llm/stream 中继、不注册 AGY 看图工具、不禁用
    // 原生 read_image;设置面板切换后热同步(无需重启)。
    const imageServiceDisposers = new Set();
    const syncImageServices = () => {
        const enabled = readImageAgyEnabled(ctx);
        if (enabled) {
            if (imageServiceDisposers.size === 0) {
                const disposeRelay = installImageRelay(ctx, () => ({
                    command: agyOptions.command,
                    proxy: agyOptions.proxy,
                }));
                if (disposeRelay !== undefined)
                    imageServiceDisposers.add(disposeRelay);
                // AGY 看图工具(全局常驻):原生 read_image 被禁用后的替代入口,
                // 任何文本主模型都能通过它看图(返回 AGY 的文字描述)。
                const disposeTool = registerReadImageAgy(ctx, () => ({
                    command: agyOptions.command,
                    proxy: agyOptions.proxy,
                }));
                if (disposeTool !== undefined)
                    imageServiceDisposers.add(disposeTool);
                // 禁用 tool-fs 的原生 read_image:它要求当前模型声明 image 输入能力,
                // 而 relay 为了让文本模型能调用它,会把模型伪声明为支持 image——
                // 于是调用成功、图片块进入历史,下一次请求才被适配器硬拒
                // (`pi-ai model "X" does not support image input`)。勾上本开关即改为
                // 走 AGY 看图,工具调用直接被拒并指路 read_image_agy。
                imageServiceDisposers.add(ctx.on('tools/pre-execute', (exec, next) => {
                    if (exec.name !== 'read_image')
                        return next();
                    return Promise.resolve({
                        kind: 'deny',
                        reason: 'read_image is disabled while "使用 AGY 读取图片" is on: '
                            + 'it requires a model that declares image input and its image block would be '
                            + 'rejected on the next request. Call read_image_agy instead (same file_path / attachment id, '
                            + 'plus an optional `prompt` to steer what to look for).',
                    });
                }));
            }
        }
        else {
            for (const dispose of imageServiceDisposers) {
                try {
                    dispose();
                }
                catch { /* 注销失败不阻断 */ }
            }
            imageServiceDisposers.clear();
        }
    };
    syncImageServices();
    ctx.on('settings/updated', (ns) => {
        if (ns === 'agy')
            syncImageServices();
    });
    // 全局子代理委派提示(section),受 agy namespace 的 delegationGuide 开关控制。
    installDelegationGuide(ctx);
}
