/**
 * `search_web_agy` 工具:AGY 驱动的深度网络搜索,独立命名、独立注册。
 *
 * 与系统自带 `web_search` 的关系:系统工具的协作式超时预算只有 60 秒
 * (tool-web 配置在 dsh 源码里,改它无法随插件分发),而 AGY 深度调研
 * 必然超过 60 秒。因此本插件提供自己的搜索工具:
 *
 * - **不设 `timeoutMs`**:timeout-policy 对没有超时预算的工具直接放行,
 *   60 秒硬限制不复存在;
 * - **超时完全自主**:由 AGY provider 的公共执行器控制
 *   (空闲 3 分钟,不设总时长,见 agy-run.ts),AGY 持续输出就续命;
 * - **行为对齐**:queries 参数与系统 web_search 一致(多查询合并为一次
 *   AGY 深度搜索),返回结构相同(内容 + sources + truncated)。
 *
 * 同时注入 systemPrompt 引导,告诉模型网络调研用本工具而非 web_search。
 * @module llm-agy/search-web-agy
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AgySearchProvider } from './search.js';
/**
 * 注册 search_web_agy 工具(全局常驻),返回注销函数。
 * @param ctx - 插件上下文(tools / systemPrompt 在 inject 中)。
 * @param getProvider - 取当前 AGY 搜索 provider(每次调用时求值,设置面板改动即时生效)。
 */
export declare function registerSearchWebAgy(ctx: Context, getProvider: () => AgySearchProvider): (() => void) | undefined;
