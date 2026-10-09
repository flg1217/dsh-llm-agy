/**
 * 「AGY 搜索接管 web_search」开关的接管动作。
 *
 * dsh 的搜索 provider 选择规则是「显式配置的 id 优先于一切已注册 provider」
 * (dsh-web 的 resolveProvider),而 base bundle 把 `web.searchProvider` 固定为
 * `deepseek-official`。只调用 `ctx.web.registerSearchProvider()` 永远抢不到
 * 选择权,所以开关必须同时改写 `web` 这一行的 config。
 *
 * 另外,一次 AGY 搜索 = 一次完整调研(实测约 130s),而 base bundle 给
 * `web_search` 的协作式预算是 60000ms(tool-web 的 `searchTimeoutMs`,
 * 由 tool-call-timeout-policy 执行)—— 不抬高预算,接管后每次搜索都会超时。
 *
 * 改写走 dsh 自己的配置通道 `ctx.configEditor`(与 settings 服务写非 volatile
 * 配置同一条路径):写 profile patch → Loader 热重载该行 → 生效。还原时写回
 * inherited 值;整份 config 与 inherited 相同时,编辑器会直接删掉这一行 config。
 *
 * 服务缺失、条目不存在、写入被 home patch 覆盖等一律只告警不抛出:接管失败
 * 不应连带打断 provider 的注册/注销。
 * @module llm-agy/provider-selection
 */
import type { Context } from '@deepseek-ai/cordis';
/** 本插件注册的搜索 provider id。 */
export declare const AGY_SEARCH_PROVIDER_ID = "agy";
/** 被接管的搜索选择条目(dsh base bundle 的 web 行)。 */
export declare const WEB_SEARCH_ENTRY_ID = "web";
/** 承载 web_search 超时预算的条目与字段(base bundle 默认 60000ms)。 */
export declare const TOOL_WEB_ENTRY_ID = "tool-web";
export declare const SEARCH_TIMEOUT_FIELD = "searchTimeoutMs";
/**
 * 接管时要保证的 web_search 预算(ms)。一次 AGY 调研实测 130s 左右,
 * 留约 2 倍余量;只在当前预算更低时抬高,不压低用户自己配的更大值。
 */
export declare const AGY_SEARCH_TIMEOUT_MS = 300000;
/** configEditor 的条目最小结构面(只用到 id/config 两个字段)。 */
export interface ConfigEntryLike {
    options: {
        id: string;
        name?: string;
        config?: unknown;
    };
}
/** 一条已加载条目及其继承层(来自 profile 之下的 bundle 层)。 */
export interface ConfigRowLike {
    entry: ConfigEntryLike;
    inherited: Record<string, unknown>;
    override: Record<string, unknown>;
}
/**
 * `ctx.configEditor` 的最小结构面。该服务是可选依赖(未挂载 config-editor 的
 * 部署没有它),因此不 import 其类型、不做硬 inject,只按用到的两个方法取。
 */
export interface ProviderSelectionEditor {
    configuration(): ConfigRowLike[];
    edit(entry: ConfigEntryLike, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
}
/** 取当前可用的 configEditor;未挂载或形态不符时返回 undefined。 */
export declare function providerSelectionEditor(ctx: Context): ProviderSelectionEditor | undefined;
/**
 * 应用(或还原)接管:让全局 web_search 既选中 AGY、又有够用的超时预算。
 * @param editor - configEditor;undefined 表示该部署未挂载,直接跳过。
 * @param enabled - 开关状态:true 接管,false 还原。
 * @returns 实际被改写的条目 id(空数组 = 无需改动或接管不可用)。
 */
export declare function applySearchTakeover(editor: ProviderSelectionEditor | undefined, enabled: boolean): Promise<string[]>;
