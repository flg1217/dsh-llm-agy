/**
 * AGY 可用模型查询。
 *
 * AGY CLI 自带 `models` 子命令,输出 `id\t名称` 逐行(stdout);
 * "Fetching available models..." 等提示走 stderr,不影响解析。
 * 主代理先查询再以准确的 model id 委派(`list_agy_models` 工具)。
 *
 * 查询必须**走设置面板的代理**(与适配器/设置面板路由同款 env):AGY CLI
 * 依赖代理出网,不设代理会超时或返回空。工具与设置面板共用本模块的异步
 * 查询(不阻塞事件循环——`agy models` 走网络,实测可达分钟级)。
 * @module llm-agy/models
 */
import type { Context } from '@deepseek-ai/cordis';
/** 异步查询的结果:条目 + stderr 尾部(诊断用,失败时给主代理看原因)。 */
export interface AgyModelsResult {
    entries: Array<{
        id: string;
        name?: string;
    }>;
    stderrTail: string;
}
/**
 * 异步查询 `agy models`,返回结构化条目(不阻塞事件循环,供设置面板路由与
 * `list_agy_models` 工具共用)。失败/超时/解析不到时 entries 为空数组。
 * @param command - AGY CLI 入口。
 * @param opts - 超时、代理(AGY CLI 需要代理出网)。
 * @returns 条目与 stderr 尾(最多 3 行,便于诊断"没网/没代理")。
 */
export declare function listAgyModelEntriesAsync(command: string, opts?: {
    timeoutMs?: number;
    proxy?: string;
}): Promise<AgyModelsResult>;
/**
 * 注册模型查询工具(与 subagent_agy_ui 配套)。
 * command/proxy 用 getter 实时求值:设置面板改了立即生效,不必重启。
 */
export declare function registerAgyModelsTool(ctx: Context, options: {
    command: () => string;
    proxy: () => string;
    toolName: string;
}): void;
