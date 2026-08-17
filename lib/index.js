/**
 * llm-agy 插件入口:注册 AGY(Antigravity CLI)模型适配器 + 搜索 provider。
 * 对齐 llm-deepseek/index.ts 的结构:Config 定义 + apply 注册 provider 路由。
 * @module llm-agy
 */
import z from '@deepseek-ai/schemastery';
import { apply as applyToolSubagent } from '@deepseek-ai/dsh-tool-subagent';
import { AgyLlmAdapter } from './adapter.js';
import { AgySearchProvider } from './search.js';
import { registerAgySettings } from './settings.js';
import { installImageRelay } from './image-paste.js';
import { registerReadImageAgy } from './read-image.js';
import { installDelegationGuide } from './delegate-guide.js';
export const name = 'llm-agy';
export const inject = ['llm', 'web', 'tools'];
export const Config = z.object({
    command: z.string().default('agy'),
    model: z.string().default('gemini-3.7-flash-high'),
    effort: z.string().default('high'),
    extraArgs: z.array(z.string()).default([]),
    proxy: z.string().default('http://127.0.0.1:7890'),
    searchProviderId: z.string().default('agy'),
    registerSubagentTools: z.boolean().default(true),
});
/** 子代理委派工具:前端/UI 走 AGY/Gemini,独立于主模型。看图已由 read_image_agy 取代,不再注册子代理。 */
function registerSubagentTools(ctx, model) {
    const agentOptions = { provider: 'agy', model };
    // 动态挂载官方 @deepseek-ai/dsh-tool-subagent 实例注册工具,插件自包含,
    // 无需修改 dsh 源码或 agent 预设;工具随 provider 出现而注册,全局可见。
    ctx.plugin(applyToolSubagent, {
        provider: 'spawn',
        toolName: 'subagent_agy_ui',
        backgroundMode: 'continuable',
        agentOptions,
    });
}
export function apply(ctx, config) {
    ctx.llm.registerAdapter(['agy'], new AgyLlmAdapter(ctx, {
        command: config.command ?? 'agy',
        model: config.model ?? 'gemini-3.7-flash-high',
        effort: config.effort ?? 'high',
        extraArgs: config.extraArgs ?? [],
        proxy: config.proxy,
    }));
    // 子代理委派工具:前端/UI 设计(subagent_agy_ui,continuable 可复用长线会话),
    // 由 AGY/Gemini 驱动;看图不委派子代理(用全局 read_image_agy)。
    if (config.registerSubagentTools !== false) {
        registerSubagentTools(ctx, config.model ?? 'gemini-3.7-flash-high');
    }
    // AGY 的 search_web 工具接入 dsh 搜索框架:searchProvider 配置为 'agy' 即启用。
    const searchProviderId = config.searchProviderId ?? 'agy';
    if (searchProviderId !== '' && ctx.web !== undefined) {
        ctx.web.registerSearchProvider(new AgySearchProvider({
            command: config.command ?? 'agy',
            model: config.model ?? 'gemini-3.7-flash-high',
            effort: config.effort ?? 'high',
            proxy: config.proxy,
        }));
    }
    // 设置面板 AntiGravity 配置区 + /agy 命令(status/test/help)。
    registerAgySettings(ctx);
    // 注:read_image 覆盖由 router-agy 预设的 read-image-override.mjs
    // (agent 作用域同名注册 shadow 全局)实现,受 agy namespace 的
    // overrideReadImage 开关控制;此处无需注册。
    // 输入栏贴图:llm/stream 监听器,后端把 ImageBlock 落盘为路径文本。
    // 不新增 provider、不改模型路由、不改前端——用户完全无感。
    installImageRelay(ctx);
    // read_image_agy 工具:全局常驻,任何会话(含非预设)的文本主模型都可直接读图。
    registerReadImageAgy(ctx, () => ({
        command: config.command ?? 'agy',
        proxy: config.proxy ?? 'http://127.0.0.1:7890',
    }));
    // 全局看图分工提示(section),受 agy namespace 的 delegationGuide 开关控制。
    installDelegationGuide(ctx);
}
