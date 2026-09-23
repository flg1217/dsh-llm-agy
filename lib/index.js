/**
 * llm-agy 插件入口:注册 AGY(Antigravity CLI)模型适配器 + 搜索 provider。
 * 对齐 llm-deepseek/index.ts 的结构:Config 定义 + apply 注册 provider 路由。
 * @module llm-agy
 */
import z from '@deepseek-ai/schemastery';
import { AgyLlmAdapter } from './adapter.js';
import { AgySearchProvider } from './search.js';
import { registerAgySearchTool } from './search-tool.js';
import { readDshExecutorEnabled, readImageAgyEnabled, readImageToolGateEnabled, registerAgySettings, searchOverrideEnabled, } from './settings.js';
import { registerDshMcpServer } from '@flg1217/dsh-mcp';
import { installImageRelay } from './image-paste.js';
import { installImageToolGate } from './image-tool-gate.js';
import { captureAttachments, registerReadImageAgy } from './read-image.js';
import { installDelegationGuide } from './delegate-guide.js';
import { registerSubagentTool } from './subagent-tool.js';
import { registerAgyModelsTool } from './models.js';
import { registerAgyModelsRoute } from './models-route.js';
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
function registerSubagentTools(ctx, model) {
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
            + `supported ids); omit it to use the plugin-configured default model (\`${model}\`).`,
        promptDescription: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include '
            + 'everything it needs: the goal, acceptance criteria, exact file paths, constraints, and the expected output format.',
    });
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
    // 设置面板的模型列表路由:插件卡槽位拿不到会话级 remote,发现只能自建
    // (围栏与 /api 网关行为一致,见 models-route.ts 模块头)。带缓存:agy models
    // 走网络很慢,刷新期间与失败时都回旧值。
    ctx.effect(() => registerAgyModelsRoute(ctx, () => ({ command: agyOptions.command, proxy: agyOptions.proxy })));
    ctx.llm.registerAdapter(['agy'], new AgyLlmAdapter(ctx, {
        command: agyOptions.command,
        model: agyOptions.model,
        effort: agyOptions.effort,
        extraArgs: config.extraArgs ?? [],
        proxy: agyOptions.proxy,
        // view_file 读到图片时走图片块通道(附件提交 + 画廊授权),与
        // read_image_agy 共用同一捕获的服务。
        getAttachments: captureAttachments(ctx),
        // AGY 工具全 dsh 化(getter,默认开):dsh-executor 自定义 agent 禁内置
        // 工具,全部工具经本插件注册的 dsh MCP 端点。
        dshExecutor: () => readDshExecutorEnabled(ctx),
    }));
    // dsh 的 MCP 端点(AGY 工具全 dsh 化通道):共享 @flg1217/dsh-mcp 提供单一
    // 端点(/api/dsh-mcp);agy 以 --agent dsh-executor 经全局 mcp_config.json 连接。
    registerDshMcpServer(ctx);
    // 子代理委派工具:前端/UI 设计(subagent_agy_ui,continuable 可复用长线会话),
    // 由 AGY/Gemini 驱动;看图不委派子代理(用全局 read_image_agy)。
    if (config.registerSubagentTools !== false) {
        registerSubagentTools(ctx, agyOptions.model);
    }
    // 模型查询工具:委派前可先确认当前支持的模型 id。command/proxy 用 getter
    // 实时读设置——之前透传的是一次性取值(默认代理而非面板配置的代理),
    // 导致 list_agy_models 不走设置里的代理。
    registerAgyModelsTool(ctx, {
        command: () => agyOptions.command,
        proxy: () => agyOptions.proxy,
        toolName: 'list_agy_models',
    });
    // AGY 搜索接入(searchOverride 开关热切换):
    // - 开:注册进全局 web 搜索缝(ctx.web),全局 web_search 工具走 AGY;
    // - 关:不占全局缝(避免与其它 provider 冲突),只注册独立 agy_web_search 工具。
    const searchOptions = () => ({
        command: config.command ?? 'agy',
        model: config.model ?? 'gemini-3.7-flash-high',
        effort: config.effort ?? 'high',
        proxy: config.proxy,
    });
    const searchDisposers = new Set();
    const syncSearch = () => {
        for (const dispose of searchDisposers) {
            try {
                dispose();
            }
            catch { /* 注销失败不阻断 */ }
        }
        searchDisposers.clear();
        if (searchOverrideEnabled(ctx)) {
            if (ctx.web !== undefined) {
                try {
                    searchDisposers.add(ctx.web.registerSearchProvider(new AgySearchProvider(searchOptions())));
                }
                catch { /* 注册冲突等异常不阻断 */ }
            }
        }
        else {
            const dispose = registerAgySearchTool(ctx, searchOptions());
            if (dispose !== undefined)
                searchDisposers.add(dispose);
        }
    };
    syncSearch();
    // 设置面板 AntiGravity 配置区 + /agy 命令(status/test/help)。
    registerAgySettings(ctx);
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
                // 读图工具闸门(按模型模态分流,见 image-tool-gate.ts):
                // - 仅文本(或能力未知)路由:禁 dsh 原生 read_image、指路 read_image_agy
                //   (relay 的伪声明会让原生调用"成功",图片块进历史后下一次请求才被硬拒);
                // - 多模态路由:禁 read_image_agy、指路 read_image(转述对能直接看图的模型是纯损失)。
                // 受设置「按模型模态分流读图工具」控制(每次调用热读,切换即时生效)。
                imageServiceDisposers.add(installImageToolGate(ctx, () => readImageToolGateEnabled(ctx)));
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
        if (ns === 'agy') {
            syncSearch();
            syncImageServices();
        }
    });
    // 全局子代理委派提示(section),受 agy namespace 的 delegationGuide 开关控制。
    installDelegationGuide(ctx);
}
