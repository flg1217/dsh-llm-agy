/**
 * AGY 设置区与命令:
 * - installSettingsSection 注册 `agy` namespace,设置面板自动出现 AntiGravity 配置表单。
 * - /agy 命令:status(检测安装/登录)、test(发起回复 hi 的测试)、help。
 * @module llm-agy/settings
 */
import z from '@deepseek-ai/schemastery';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
export const AGY_SETTINGS_NAMESPACE = settingsNamespace('agy');
/** AGY 设置表单 schema(schemastery Schema;settings.register 会把 schema 当函数调用)。 */
export const AgySettingsConfig = z.object({
    command: z.string().default('agy').description('agy 可执行文件命令(默认 agy)'),
    model: z.string().default('gemini-3.7-flash-high').description('传给 --model 的 AGY 模型'),
    effort: z.string().default('high').description('推理强度 low/medium/high'),
    proxy: z.string().default('http://127.0.0.1:7890').description('AGY 流量代理(空字符串禁用)'),
});
/** 检测 AGY 是否已安装(命令存在)。 */
export function agyInstalled(command) {
    const r = spawnSync(command, ['--version'], { stdio: 'ignore', windowsHide: true });
    return r.error === undefined;
}
/**
 * 检测 AGY 登录状态。
 * 注意:`agy auth status` 不是有效命令(会挂起),不能用于检测。
 * 可靠依据:AGY 数据目录存在 + 已有会话记录(说明完成过登录与使用)。
 */
export function agyLoggedIn() {
    const base = join(process.env.USERPROFILE ?? '', '.gemini', 'antigravity-cli');
    if (!existsSync(base))
        return false;
    // 有会话记录 = 已登录使用过;cli.log 有成功活动也可佐证。
    const conversations = join(base, 'conversations');
    if (existsSync(conversations)) {
        try {
            return readdirSync(conversations).length > 0;
        }
        catch { /* 目录读失败按未登录 */ }
    }
    return false;
}
/** 发起真实测试:让 AGY 回答一个真实问题,返回实际回复内容。 */
export function agyTest(command, proxy) {
    return new Promise((resolve) => {
        const proc = spawn(command, [
            '-p', '请用一句简短的话回答:你好,请介绍一下你自己是谁?',
            '--output-format', 'text',
            '--print-timeout', '60m',
            '--dangerously-skip-permissions',
        ], {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            env: proxy
                ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy }
                : { ...process.env },
        });
        let out = '';
        proc.stdout?.setEncoding('utf8');
        proc.stdout?.on('data', (d) => { out += d; });
        const killer = setTimeout(() => proc.kill(), 60_000);
        proc.on('close', (code) => {
            clearTimeout(killer);
            const text = out.trim();
            resolve({ ok: code === 0 && text.length > 0, output: text || `exit ${code}` });
        });
        proc.on('error', (err) => {
            clearTimeout(killer);
            resolve({ ok: false, output: String(err) });
        });
    });
}
/** 官方安装命令(供复制)。 */
export const INSTALL_COMMANDS = [
    'winget install --id Google.Antigravity',
    '# 或 macOS / Linux:',
    'brew install --cask antigravity',
];
/** 工具说明列表。 */
export const TOOL_DESCRIPTIONS = [
    { name: 'subagent_agy_ui', desc: '前端/UI 设计、样式研究、视觉实现、截图核验(continuable 可复用长线会话)' },
    { name: 'subagent_agy_vision', desc: '看图:截图/设计稿分析(one-shot 一次性)' },
    { name: 'web_search(agy provider)', desc: 'web_search 工具走 AGY 的 Google 搜索(search_web),返回完整深度搜索内容' },
];
/** 注册设置区、命令与模型探测通道(客户端面板按钮走 api.llm.discoverModels,不落会话)。 */
export function registerAgySettings(ctx) {
    let current = () => ({});
    installSettingsSection(ctx, AGY_SETTINGS_NAMESPACE, AgySettingsConfig, {}, {
        setSource: (source) => { current = source; },
        onChange: () => { },
    });
    const sectionOf = () => current();
    // 模型探测通道:客户端 api.llm.discoverModels({settingsNs:'agy', provider:'status'|'test'})
    // → 服务端直接 spawn agy CLI,返回结果(机制通用,语义伪装成 model 列表)。
    // 全程不落会话、不动源码。
    const llm = ctx.get('llm');
    if (llm !== undefined && typeof llm.registerModelDiscovery === 'function') {
        llm
            .registerModelDiscovery(AGY_SETTINGS_NAMESPACE, async (request) => {
            const section = sectionOf();
            const command = section.command ?? 'agy';
            const proxy = section.proxy ?? 'http://127.0.0.1:7890';
            const action = request.provider ?? 'status';
            if (action === 'test') {
                const { ok, output } = await agyTest(command, proxy);
                return [{
                        id: 'agy-test',
                        // 展示 AGY 的真实回复内容(而非固定 hi)。
                        name: ok ? output.slice(0, 300) : `✗ AGY 测试失败:${output.slice(0, 300)}`,
                    }];
            }
            const installed = agyInstalled(command);
            const loggedIn = installed && agyLoggedIn();
            return [{
                    id: 'agy-status',
                    name: `AGY 安装:${installed ? '✓ 已安装' : '✗ 未安装'} | 登录状态:${installed ? (loggedIn ? '✓ 已登录' : '✗ 未登录') : '-'} | 命令:${command}`,
                }];
        });
    }
    const commands = ctx.get('commands');
    if (commands !== undefined) {
        commands.register({
            name: 'agy',
            description: 'AntiGravity(AGY)状态检测 / 测试 / 帮助。用法:/agy status|test|help',
            handler: async (invocation) => {
                const input = invocation.rawInput.trim().toLowerCase();
                const section = sectionOf();
                const command = section.command ?? 'agy';
                const proxy = section.proxy ?? 'http://127.0.0.1:7890';
                if (input === 'status') {
                    const installed = agyInstalled(command);
                    const loggedIn = installed && agyLoggedIn();
                    return {
                        kind: 'success',
                        text: `AGY 安装:${installed ? '✓ 已安装' : '✗ 未安装'}\n登录状态:${installed ? (loggedIn ? '✓ 已登录' : '✗ 未登录') : '-'}\n命令:${command}`,
                    };
                }
                if (input === 'test') {
                    const { ok, output } = await agyTest(command, proxy);
                    return ok
                        ? { kind: 'success', text: `AGY 回复:${output.slice(0, 300)}` }
                        : { kind: 'error', text: `AGY 测试失败:${output.slice(0, 300)}` };
                }
                return {
                    kind: 'success',
                    text: `AntiGravity(AGY)接入 dsh\n- /agy status 检测安装与登录\n- /agy test 发起测试指令(回复 hi)\n安装:${INSTALL_COMMANDS[0]}\n工具:subagent_agy_ui / subagent_agy_vision / web_search(agy)`,
                };
            },
        });
    }
}
