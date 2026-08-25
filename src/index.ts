/**
 * llm-agy 插件入口:注册 AGY(Antigravity CLI)模型适配器 + 搜索 provider。
 * 对齐 llm-deepseek/index.ts 的结构:Config 定义 + apply 注册 provider 路由。
 * @module llm-agy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AgyLlmAdapter } from './adapter.js'
import { AgySearchProvider } from './search.js'
import { registerAgySearchTool } from './search-tool.js'
import { readImageAgyEnabled, registerAgySettings, searchOverrideEnabled } from './settings.js'
import { installImageRelay } from './image-paste.js'
import { installDelegationGuide } from './delegate-guide.js'
import { registerSubagentTool } from './subagent-tool.js'
import { registerAgyModelsTool } from './models.js'

export const name = 'llm-agy'
export const inject = ['llm', 'web', 'tools', 'subagents', 'systemPrompt']

export interface Config {
  /** agy 可执行文件,默认 `agy`。 */
  command?: string
  /** 传给 `--model` 的 AGY 模型。 */
  model?: string
  /** 传给 `--effort` 的 AGY 推理强度。 */
  effort?: string
  /** 追加的额外 AGY 参数。 */
  extraArgs?: string[]
  /** AGY 资格检查/API 流量代理,默认 `http://127.0.0.1:7890`;空字符串禁用。 */
  proxy?: string
  /** 是否注册 `subagent_agy_ui` 子代理工具(默认开启)。 */
  registerSubagentTools?: boolean
}

export const Config: z<Config> = z.object({
  command: z.string().default('agy'),
  model: z.string().default('gemini-3.7-flash-high'),
  effort: z.string().default('high'),
  extraArgs: z.array(z.string()).default([]),
  proxy: z.string().default('http://127.0.0.1:7890'),
  registerSubagentTools: z.boolean().default(true),
})

/** 子代理委派工具:前端/UI 走 AGY/Gemini,独立于主模型。看图已由 read_image_agy 取代,不再注册子代理。 */
function registerSubagentTools(ctx: Context, model: string, command: string): void {
  const agentOptions = { provider: 'agy', model }
  // 自定义注册委派工具(替代官方 dsh-tool-subagent),以便在工具描述里
  // 内置"完整上下文"指引;机制一致(continuable 后台 + 前台回退)。
  registerSubagentTool(ctx, {
    provider: 'spawn',
    toolName: 'subagent_agy_ui',
    agentOptions,
    description:
      'Delegate a frontend/UI implementation task to an AGY/Gemini subagent (a separate agent driven by the '
      + 'Antigravity CLI) — UI design, styling research, visual implementation, screenshot verification — so it does '
      + 'not consume this conversation\'s context. The subagent returns its result, not its intermediate steps.\n\n'
      + 'Provide COMPLETE context for every delegation — the subagent does not see this conversation and cannot ask '
      + 'follow-up questions: (1) the goal and acceptance criteria; (2) exact file/directory paths to touch or inspect; '
      + '(3) constraints and boundaries (what NOT to do, what to preserve); (4) the expected output format. Split complex '
      + 'tasks into independent subagents and run them in parallel. '
      + 'This tool runs in the background by default: it immediately returns a durable subagent id and keeps the child '
      + 'conversation available for later turns; when the run settles, the runtime sends you a notice containing its '
      + 'outcome and any final assistant message. Set `run_in_background: false` only when your next action depends on '
      + 'receiving the result; `send_message` starts a later turn in the same child conversation. '
      + 'Optionally pass a `model` argument with an exact model id (query `list_agy_models` for the currently '
      + 'supported ids); omit it to use the plugin-configured default model.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include '
      + 'everything it needs: the goal, acceptance criteria, exact file paths, constraints, and the expected output format.',
  })
  // 模型查询工具:委派前可先确认当前支持的模型 id。
  registerAgyModelsTool(ctx, { command, toolName: 'list_agy_models' })
}

export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter(['agy'], new AgyLlmAdapter(ctx, {
    command: config.command ?? 'agy',
    model: config.model ?? 'gemini-3.7-flash-high',
    effort: config.effort ?? 'high',
    extraArgs: config.extraArgs ?? [],
    proxy: config.proxy,
  }))
  // 子代理委派工具:前端/UI 设计(subagent_agy_ui,continuable 可复用长线会话),
  // 由 AGY/Gemini 驱动;看图不委派子代理(用全局 read_image_agy)。
  if (config.registerSubagentTools !== false) {
    registerSubagentTools(ctx, config.model ?? 'gemini-3.7-flash-high', config.command ?? 'agy')
  }
  // AGY 搜索接入(searchOverride 开关热切换):
  // - 开:注册进全局 web 搜索缝(ctx.web),全局 web_search 工具走 AGY;
  // - 关:不占全局缝(避免与其它 provider 冲突),只注册独立 agy_web_search 工具。
  const searchOptions = () => ({
    command: config.command ?? 'agy',
    model: config.model ?? 'gemini-3.7-flash-high',
    effort: config.effort ?? 'high',
    proxy: config.proxy,
  })
  const searchDisposers = new Set<() => void>()
  const syncSearch = () => {
    for (const dispose of searchDisposers) {
      try { dispose() } catch { /* 注销失败不阻断 */ }
    }
    searchDisposers.clear()
    if (searchOverrideEnabled(ctx)) {
      if (ctx.web !== undefined) {
        try {
          searchDisposers.add(ctx.web.registerSearchProvider(new AgySearchProvider(searchOptions())))
        } catch { /* 注册冲突等异常不阻断 */ }
      }
    } else {
      const dispose = registerAgySearchTool(ctx, searchOptions())
      if (dispose !== undefined) searchDisposers.add(dispose)
    }
  }
  syncSearch()
  // 设置面板 AntiGravity 配置区 + /agy 命令(status/test/help)。
  registerAgySettings(ctx)
  // 注:read_image 覆盖由 router-agy 预设的 read-image-override.mjs
  // (agent 作用域同名注册 shadow 全局)实现,受 agy namespace 的
  // overrideReadImage 开关控制;此处无需注册。
  // 图片中继(AGY 就地读图):受 agy settings namespace 的 readImageAgy 开关控制
  // (默认开启)。关闭时不注入 llm/stream 中继与 resolveModelInfo 包装;
  // 设置面板切换后热同步(无需重启)。
  const imageServiceDisposers = new Set<() => void>()
  const syncImageServices = () => {
    const enabled = readImageAgyEnabled(ctx)
    if (enabled) {
      if (imageServiceDisposers.size === 0) {
        const disposeRelay = installImageRelay(ctx, () => ({
          command: config.command ?? 'agy',
          proxy: config.proxy ?? 'http://127.0.0.1:7890',
        }))
        if (disposeRelay !== undefined) imageServiceDisposers.add(disposeRelay)
      }
    } else {
      for (const dispose of imageServiceDisposers) {
        try { dispose() } catch { /* 注销失败不阻断 */ }
      }
      imageServiceDisposers.clear()
    }
  }
  syncImageServices()
  ctx.on('settings/updated', (ns: string) => {
    if (ns === 'agy') {
      syncSearch()
      syncImageServices()
    }
  })
  // 全局子代理委派提示(section),受 agy namespace 的 delegationGuide 开关控制。
  installDelegationGuide(ctx)
}
