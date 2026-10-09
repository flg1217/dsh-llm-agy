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
/** 本插件注册的搜索 provider id。 */
export const AGY_SEARCH_PROVIDER_ID = 'agy';
/** 被接管的搜索选择条目(dsh base bundle 的 web 行)。 */
export const WEB_SEARCH_ENTRY_ID = 'web';
/** 承载 web_search 超时预算的条目与字段(base bundle 默认 60000ms)。 */
export const TOOL_WEB_ENTRY_ID = 'tool-web';
export const SEARCH_TIMEOUT_FIELD = 'searchTimeoutMs';
/**
 * 接管时要保证的 web_search 预算(ms)。一次 AGY 调研实测 130s 左右,
 * 留约 2 倍余量;只在当前预算更低时抬高,不压低用户自己配的更大值。
 */
export const AGY_SEARCH_TIMEOUT_MS = 300_000;
/** 取当前可用的 configEditor;未挂载或形态不符时返回 undefined。 */
export function providerSelectionEditor(ctx) {
    const service = ctx.get('configEditor');
    if (service === undefined)
        return undefined;
    return typeof service.configuration === 'function' && typeof service.edit === 'function' ? service : undefined;
}
/** 一个条目的当前生效配置(未配置过则为空对象)。 */
function configOf(row) {
    return (row.entry.options.config ?? {});
}
/**
 * 写入一个字段。目标值与当前生效值相同则完全不碰配置 —— 否则每次启动都会
 * 白写一次并触发一次条目重载。目标值 `undefined` 表示删除该字段(回落继承层)。
 * @returns 是否真的写入了。
 */
async function writeField(editor, row, field, target) {
    if (configOf(row)[field] === target)
        return false;
    await editor.edit(row.entry, (raw) => {
        const next = { ...raw };
        if (target === undefined)
            Reflect.deleteProperty(next, field);
        else
            next[field] = target;
        return next;
    });
    return true;
}
/**
 * 应用(或还原)接管:让全局 web_search 既选中 AGY、又有够用的超时预算。
 * @param editor - configEditor;undefined 表示该部署未挂载,直接跳过。
 * @param enabled - 开关状态:true 接管,false 还原。
 * @returns 实际被改写的条目 id(空数组 = 无需改动或接管不可用)。
 */
export async function applySearchTakeover(editor, enabled) {
    if (editor === undefined)
        return [];
    const rows = editor.configuration();
    const changed = [];
    // 1. 选择权:不写这一行,注册进来的 provider 永远轮不到。
    const web = rows.find(row => row.entry.options.id === WEB_SEARCH_ENTRY_ID);
    if (web !== undefined) {
        const target = enabled ? AGY_SEARCH_PROVIDER_ID : web.inherited.searchProvider;
        if (await writeField(editor, web, 'searchProvider', target))
            changed.push(WEB_SEARCH_ENTRY_ID);
    }
    // 2. 预算:接管期间才需要长预算;关闭时只回收本插件自己设的那一档,
    //    用户手写的更大值原样保留(不能替用户改回默认)。
    const toolWeb = rows.find(row => row.entry.options.id === TOOL_WEB_ENTRY_ID);
    if (toolWeb !== undefined) {
        const current = configOf(toolWeb)[SEARCH_TIMEOUT_FIELD];
        const target = enabled
            ? (typeof current === 'number' && current >= AGY_SEARCH_TIMEOUT_MS ? current : AGY_SEARCH_TIMEOUT_MS)
            : (current === AGY_SEARCH_TIMEOUT_MS ? toolWeb.inherited[SEARCH_TIMEOUT_FIELD] : current);
        if (await writeField(editor, toolWeb, SEARCH_TIMEOUT_FIELD, target))
            changed.push(TOOL_WEB_ENTRY_ID);
    }
    return changed;
}
