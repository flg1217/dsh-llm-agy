/**
 * dsh-executor 自定义 agent 的自动化部署(llm-agy 侧)。
 *
 * 重构目标(AGY 工具全 dsh 化):让 AGY 子代理**不再使用自带内置工具**,
 * 全部工具调用走 dsh 的 MCP 端点(与 codebuddy 桥同构——审批/沙箱/会话
 * 审计/后台面板全部由 dsh 接管)。
 *
 * 两条部署(幂等,每轮 spawn 前确保):
 * 1. **agent.md**:写 `~/.gemini/antigravity-cli/agents/dsh-executor/agent.md`
 *    —— 实测关键配置(PoC,2026-09-19):
 *    - `tools: []` + `inheritMcp: true`:内置工具只剩 4 个基础设施
 *      (call_mcp_tool/manage_task/list_resources/read_resource),
 *      **MCP 工具直接展开为一等工具**(不是壳);
 *    - **不要写 `excludeDefaultComponents: true`**——实测它会把 MCP 工具的
 *      展开也一起杀掉(只剩 call_mcp_tool 壳)。
 * 2. **MCP 配置**:写 `~/.gemini/config/mcp_config.json` 的 `dsh` 条目
 *    —— `{ disabled: false, serverUrl: <dsh 端点>&session=<本 agent 会话>&key=<key> }`
 *    —— AGY 全局配置只有一个 `dsh` 条目。
 *
 * **已知并发限制**:两个 dsh 会话并行首启时,"写配置 + spawn"在事件循环内虽
 * 是原子的,但 AGY 进程**在 init 阶段才读配置**——后写者可能覆盖先启动进程
 * 尚未读到的条目,使先者连上后者的会话 URL(工具在对方会话执行)。窗口窄
 * (进程启动毫秒级)但真实存在。修法需"等 A 进程 init 后再 spawn B"的串行化
 * (或 AGY 侧 per-agent MCP 配置),暂记录为待办。
 * @module llm-agy/agy-executor
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** 自定义 agent 名(agy --agent <name>)。 */
export const EXECUTOR_AGENT_NAME = 'dsh-executor';
/** MCP 服务器条目名(agy mcp list 里显示的名字)。 */
export const DSH_MCP_SERVER_NAME = 'dsh';
/** agent.md 全文(内容随配置语义变更时更新,便于幂等对比)。 */
export const EXECUTOR_AGENT_MD = `---
name: ${EXECUTOR_AGENT_NAME}
description: dsh 工具执行体——禁用全部内置工具,所有操作经 dsh 的 MCP 工具完成。
inheritMcp: true
inheritCustomizations: false
tools: []
mainAgent: true
subagent: false
---

# dsh-executor

你是在 dsh 框架里运行的执行体:沙箱、审批、会话审计与后台任务面板都在 dsh 侧。

## 约束

1. 你没有 run_command / view_file / write_to_file / grep_search 等本地内置工具。
2. 所有检查、查询与副作用只能通过已连接的 MCP 工具完成(dsh 工具集)。
3. 需要结果的命令用后台任务参数(run_in_background)交给 dsh,完成通知会唤醒你;
   不要用外部方式(自写轮询脚本等)绕过 dsh 的后台任务面板。
4. 若某项操作没有任何 MCP 工具能完成,如实说明能力缺口,不要尝试本地回退。
`;
/** AGY 自定义 agent 目录(用户级)。 */
function executorAgentFile() {
    return join(homedir(), '.gemini', 'antigravity-cli', 'agents', EXECUTOR_AGENT_NAME, 'agent.md');
}
/** AGY 全局 MCP 配置(官方文档:Global Configuration 路径)。 */
function mcpConfigFile() {
    return join(homedir(), '.gemini', 'config', 'mcp_config.json');
}
/**
 * 确保自定义 agent 已部署;内容变化时覆写。
 * @returns 本次是否发生了写入(便于日志)。
 */
export function ensureExecutorAgent() {
    const file = executorAgentFile();
    try {
        if (existsSync(file)) {
            const current = readFileSync(file, 'utf8');
            if (current === EXECUTOR_AGENT_MD)
                return false;
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, EXECUTOR_AGENT_MD);
        return true;
    }
    catch (error) {
        console.warn(`[llm-agy] 部署 ${EXECUTOR_AGENT_NAME} agent.md 失败: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
/**
 * 读取 mcp_config.json。
 * @returns 不存在/不可读 → `{}`(首次部署,可安全新建);**存在但损坏 → undefined**
 *   (调用方必须跳过写入——把解析失败的残缺内容整体写回会静默清空用户
 *   其余的 MCP 服务器条目,如 codegraph)。
 */
function readMcpConfig() {
    let raw;
    try {
        raw = readFileSync(mcpConfigFile(), 'utf8');
    }
    catch {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
/**
 * 确保 dsh MCP 条目指向给定端点 URL;已是同一 URL 时跳过写入。
 *
 * **只改 `dsh` 一条**:其余用户的 MCP 服务器(codegraph 等)原样保留。
 * @param serverUrl - 完整 dsh MCP 端点(含 session/key 查询参数)。
 * @returns 本次是否发生了写入。
 */
export function ensureDshMcpConfig(serverUrl) {
    const file = mcpConfigFile();
    const config = readMcpConfig();
    if (config === undefined) {
        // 文件存在但解析失败:留 .bak 后跳过——绝不整体覆盖(会丢用户其它 MCP 服务器)。
        try {
            copyFileSync(file, `${file}.bak`);
        }
        catch { /* 备份失败不阻断 */ }
        console.warn('[llm-agy] mcp_config.json 解析失败(已留 .bak),本次跳过 dsh 条目写入,不覆盖用户配置');
        return false;
    }
    const servers = config.mcpServers ?? {};
    const existing = servers[DSH_MCP_SERVER_NAME];
    if (existing?.serverUrl === serverUrl)
        return false;
    servers[DSH_MCP_SERVER_NAME] = { disabled: false, serverUrl };
    config.mcpServers = servers;
    try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
        return true;
    }
    catch (error) {
        console.warn(`[llm-agy] 写 MCP 配置失败: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
/**
 * 移除 `dsh` 条目(dshExecutor 关闭时调用;其余 MCP 服务器原样保留)。
 *
 * 不清理的后果:默认 AGY agent 的 `inheritMcp` 会继承这条残留条目,而它带着
 * **上一个会话的 session/key**——工具调用会打到一个不存在/无关的会话上报错,
 * 或更糟,打到另一个 dsh 会话里执行。
 * @returns 本次是否发生了写入。
 */
export function removeDshMcpConfig() {
    const file = mcpConfigFile();
    const config = readMcpConfig();
    if (config === undefined)
        return false;
    const servers = config.mcpServers;
    if (servers === undefined || servers[DSH_MCP_SERVER_NAME] === undefined)
        return false;
    delete servers[DSH_MCP_SERVER_NAME];
    try {
        writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
        return true;
    }
    catch (error) {
        console.warn(`[llm-agy] 移除 MCP 配置失败: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
