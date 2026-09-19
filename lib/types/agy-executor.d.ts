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
/** 自定义 agent 名(agy --agent <name>)。 */
export declare const EXECUTOR_AGENT_NAME = "dsh-executor";
/** MCP 服务器条目名(agy mcp list 里显示的名字)。 */
export declare const DSH_MCP_SERVER_NAME = "dsh";
/** agent.md 全文(内容随配置语义变更时更新,便于幂等对比)。 */
export declare const EXECUTOR_AGENT_MD = "---\nname: dsh-executor\ndescription: dsh \u5DE5\u5177\u6267\u884C\u4F53\u2014\u2014\u7981\u7528\u5168\u90E8\u5185\u7F6E\u5DE5\u5177,\u6240\u6709\u64CD\u4F5C\u7ECF dsh \u7684 MCP \u5DE5\u5177\u5B8C\u6210\u3002\ninheritMcp: true\ninheritCustomizations: false\ntools: []\nmainAgent: true\nsubagent: false\n---\n\n# dsh-executor\n\n\u4F60\u662F\u5728 dsh \u6846\u67B6\u91CC\u8FD0\u884C\u7684\u6267\u884C\u4F53:\u6C99\u7BB1\u3001\u5BA1\u6279\u3001\u4F1A\u8BDD\u5BA1\u8BA1\u4E0E\u540E\u53F0\u4EFB\u52A1\u9762\u677F\u90FD\u5728 dsh \u4FA7\u3002\n\n## \u7EA6\u675F\n\n1. \u4F60\u6CA1\u6709 run_command / view_file / write_to_file / grep_search \u7B49\u672C\u5730\u5185\u7F6E\u5DE5\u5177\u3002\n2. \u6240\u6709\u68C0\u67E5\u3001\u67E5\u8BE2\u4E0E\u526F\u4F5C\u7528\u53EA\u80FD\u901A\u8FC7\u5DF2\u8FDE\u63A5\u7684 MCP \u5DE5\u5177\u5B8C\u6210(dsh \u5DE5\u5177\u96C6)\u3002\n3. \u9700\u8981\u7ED3\u679C\u7684\u547D\u4EE4\u7528\u540E\u53F0\u4EFB\u52A1\u53C2\u6570(run_in_background)\u4EA4\u7ED9 dsh,\u5B8C\u6210\u901A\u77E5\u4F1A\u5524\u9192\u4F60;\n   \u4E0D\u8981\u7528\u5916\u90E8\u65B9\u5F0F(\u81EA\u5199\u8F6E\u8BE2\u811A\u672C\u7B49)\u7ED5\u8FC7 dsh \u7684\u540E\u53F0\u4EFB\u52A1\u9762\u677F\u3002\n4. \u82E5\u67D0\u9879\u64CD\u4F5C\u6CA1\u6709\u4EFB\u4F55 MCP \u5DE5\u5177\u80FD\u5B8C\u6210,\u5982\u5B9E\u8BF4\u660E\u80FD\u529B\u7F3A\u53E3,\u4E0D\u8981\u5C1D\u8BD5\u672C\u5730\u56DE\u9000\u3002\n";
/**
 * 确保自定义 agent 已部署;内容变化时覆写。
 * @returns 本次是否发生了写入(便于日志)。
 */
export declare function ensureExecutorAgent(): boolean;
/**
 * 确保 dsh MCP 条目指向给定端点 URL;已是同一 URL 时跳过写入。
 *
 * **只改 `dsh` 一条**:其余用户的 MCP 服务器(codegraph 等)原样保留。
 * @param serverUrl - 完整 dsh MCP 端点(含 session/key 查询参数)。
 * @returns 本次是否发生了写入。
 */
export declare function ensureDshMcpConfig(serverUrl: string): boolean;
/**
 * 移除 `dsh` 条目(dshExecutor 关闭时调用;其余 MCP 服务器原样保留)。
 *
 * 不清理的后果:默认 AGY agent 的 `inheritMcp` 会继承这条残留条目,而它带着
 * **上一个会话的 session/key**——工具调用会打到一个不存在/无关的会话上报错,
 * 或更糟,打到另一个 dsh 会话里执行。
 * @returns 本次是否发生了写入。
 */
export declare function removeDshMcpConfig(): boolean;
