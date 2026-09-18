import { listAgyModelEntriesAsync } from './models.js';
function header(headers, name) {
    const value = headers[name];
    return typeof value === 'string' ? value : undefined;
}
/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
    try {
        return new URL(`http://${authority}`);
    }
    catch {
        return undefined;
    }
}
/** Whether the hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]')
        return true;
    const parts = hostname.split('.');
    return parts.length === 4
        && parts[0] === '127'
        && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function canonicalAuthority(entry, entryUrl) {
    const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port;
    return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isTrustedAuthority(hostUrl, trustedHosts) {
    return trustedHosts.some((entry) => {
        const entryUrl = parseAuthority(entry);
        if (entryUrl === undefined)
            return false;
        return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
            ? entryUrl.hostname === hostUrl.hostname
            : entryUrl.host === hostUrl.host;
    });
}
/**
 * Whether one request may reach this route: the Host is ours (loopback or a
 * trusted authority) and any attached browser markers are same-origin.
 */
function isTrustedApiRequest(req, trustedHosts) {
    const host = header(req.headers, 'host');
    if (host === undefined)
        return false;
    const hostUrl = parseAuthority(host);
    if (hostUrl === undefined)
        return false;
    if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts))
        return false;
    if (header(req.headers, 'sec-fetch-site') === 'cross-site')
        return false;
    const origin = header(req.headers, 'origin');
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === hostUrl.host;
    }
    catch {
        return false;
    }
}
/**
 * 注册模型列表路由。trustedHosts 取自 webStartup(与 --trusted-host 一致);
 * 服务缺失(非 web profile)时不注册。带 10 分钟内存缓存:`agy models` 走
 * 网络很慢(实测可达数分钟),刷新期间先回上一次结果,失败时也回旧值。
 * @param ctx - 插件上下文。
 * @param readOptions - 读当前生效的 AGY 命令与代理(设置面板可改)。
 * @returns 释放函数。
 */
export function registerAgyModelsRoute(ctx, readOptions) {
    const injectable = ctx;
    if (injectable.inject === undefined)
        return () => { };
    let disposeRoute;
    let cache;
    const CACHE_TTL_MS = 10 * 60 * 1000;
    /** 进行中的 agy models 拉取:慢查询(分钟级)期间重复请求共享同一次执行。 */
    let inflight;
    const loadEntries = (opts) => {
        if (inflight !== undefined)
            return inflight;
        inflight = listAgyModelEntriesAsync(opts.command, { proxy: opts.proxy })
            .then(result => result.entries)
            .finally(() => { inflight = undefined; });
        return inflight;
    };
    injectable.inject(['webServer', 'webStartup'], (injected) => {
        const web = injected.get('webServer');
        if (web?.register === undefined)
            return;
        // 服务热替换触发 inject 重跑:先释放旧路由再注册,避免旧路由泄漏。
        disposeRoute?.();
        disposeRoute = undefined;
        const startup = injected.get('webStartup');
        disposeRoute = web.register({
            kind: 'exact',
            path: '/api/llm-agy/models',
            handler: (req, res) => { void handle(req, res); },
        });
        async function handle(req, res) {
            const fail = (code, message) => {
                res.writeHead(code, message === undefined ? {} : { 'content-type': 'text/plain' });
                res.end(message ?? '');
            };
            if ((req.method ?? 'GET') !== 'GET')
                return fail(405, 'GET only');
            if (!isTrustedApiRequest(req, startup?.trustedHosts ?? []))
                return fail(403, 'untrusted request');
            const cached = cache !== undefined && Date.now() - cache.at < CACHE_TTL_MS ? cache : undefined;
            if (cached !== undefined) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, models: cached.entries, cached: true }));
                return;
            }
            try {
                const entries = await loadEntries(readOptions());
                if (entries.length > 0)
                    cache = { at: Date.now(), entries };
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, models: entries }));
            }
            catch (error) {
                // 失败时回旧缓存(若有):列表拉取很慢,宁可给旧值也不给空。
                if (cache !== undefined) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, models: cache.entries, cached: true, stale: true }));
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
            }
        }
    });
    return () => {
        disposeRoute?.();
        disposeRoute = undefined;
    };
}
