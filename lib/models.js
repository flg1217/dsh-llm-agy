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
import { defineTool } from '@deepseek-ai/dsh-tools';
import { spawn } from 'node:child_process';
/**
 * 异步查询 `agy models`,返回结构化条目(不阻塞事件循环,供设置面板路由与
 * `list_agy_models` 工具共用)。失败/超时/解析不到时 entries 为空数组。
 * @param command - AGY CLI 入口。
 * @param opts - 超时、代理(AGY CLI 需要代理出网)。
 * @returns 条目与 stderr 尾(最多 3 行,便于诊断"没网/没代理")。
 */
export async function listAgyModelEntriesAsync(command, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return new Promise((resolve) => {
        let settled = false;
        let stdout = '';
        // stderr 只留尾部若干行:诊断"代理没生效/CLI 报错"用,不无限累积。
        let stderr = '';
        const stderrTail = () => stderr.trim().split('\n').slice(-3).join('\n');
        const finish = (entries) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ entries, stderrTail: stderrTail() });
        };
        let child;
        try {
            child = spawn(command, ['models'], {
                windowsHide: true,
                ...(opts.proxy
                    ? { env: { ...process.env, HTTPS_PROXY: opts.proxy, HTTP_PROXY: opts.proxy, ALL_PROXY: opts.proxy } }
                    : {}),
            });
        }
        catch {
            return resolve({ entries: [], stderrTail: '' });
        }
        const timer = setTimeout(() => {
            try {
                child.kill();
            }
            catch { /* 已退出 */ }
            finish([]);
        }, timeoutMs);
        timer.unref?.();
        // UTF-8 流式解码:逐块 String() 会把跨 chunk 的多字节字符拆成乱码。
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk) => { if (stderr.length < 4096)
            stderr += chunk; });
        child.on('error', () => finish([]));
        child.on('close', () => {
            const entries = stdout
                .split('\n')
                .map((line) => line.replace(/\r$/, ''))
                .filter((line) => line.trim().length > 0)
                .map((line) => {
                const tab = line.indexOf('\t');
                if (tab === -1)
                    return { id: line.trim() };
                return { id: line.slice(0, tab).trim(), name: line.slice(tab + 1).trim() };
            })
                .filter(entry => entry.id.length > 0);
            finish(entries);
        });
    });
}
/**
 * 注册模型查询工具(与 subagent_agy_ui 配套)。
 * command/proxy 用 getter 实时求值:设置面板改了立即生效,不必重启。
 */
export function registerAgyModelsTool(ctx, options) {
    ctx.tools.register(defineTool({
        name: options.toolName,
        description: 'List the model ids currently supported by the AGY (Antigravity) CLI. Call this before delegating when you '
            + 'want a non-default model, then pass one of the returned ids in the `model` argument of subagent_agy_ui.',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => true,
        async execute() {
            const command = options.command();
            const { entries, stderrTail } = await listAgyModelEntriesAsync(command, { proxy: options.proxy() });
            if (entries.length === 0) {
                return `\`${command} models\` returned nothing.`
                    + (stderrTail.length === 0 ? '' : ` Stderr tail:\n${stderrTail}`);
            }
            return entries.map(entry => (entry.name === undefined ? `- ${entry.id}` : `- ${entry.id} — ${entry.name}`)).join('\n');
        },
    }));
}
