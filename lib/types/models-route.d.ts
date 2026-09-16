import type { Context } from '@deepseek-ai/cordis';
/**
 * 注册模型列表路由。trustedHosts 取自 webStartup(与 --trusted-host 一致);
 * 服务缺失(非 web profile)时不注册。带 10 分钟内存缓存:`agy models` 走
 * 网络很慢(实测可达数分钟),刷新期间先回上一次结果,失败时也回旧值。
 * @param ctx - 插件上下文。
 * @param readOptions - 读当前生效的 AGY 命令与代理(设置面板可改)。
 * @returns 释放函数。
 */
export declare function registerAgyModelsRoute(ctx: Context, readOptions: () => {
    command: string;
    proxy?: string;
}): () => void;
