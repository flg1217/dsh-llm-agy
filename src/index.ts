/**
 * llm-agy 插件入口:注册 AGY(Antigravity CLI)模型适配器 + 搜索 provider。
 * 对齐 llm-deepseek/index.ts 的结构:Config 定义 + apply 注册 provider 路由。
 * @module llm-agy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AgyLlmAdapter } from './adapter.js'
import { AgySearchProvider } from './search.js'
import { registerAgySettings } from './settings.js'

export const name = 'llm-agy'
export const inject = ['llm', 'web']

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
  /** 注册为 dsh web 搜索 provider 的 id,默认 `agy`;空字符串禁用搜索接入。 */
  searchProviderId?: string
}

export const Config: z<Config> = z.object({
  command: z.string().default('agy'),
  model: z.string().default('gemini-3.7-flash-high'),
  effort: z.string().default('high'),
  extraArgs: z.array(z.string()).default([]),
  proxy: z.string().default('http://127.0.0.1:7890'),
  searchProviderId: z.string().default('agy'),
})

export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter(['agy'], new AgyLlmAdapter(ctx, {
    command: config.command ?? 'agy',
    model: config.model ?? 'gemini-3.7-flash-high',
    effort: config.effort ?? 'high',
    extraArgs: config.extraArgs ?? [],
    proxy: config.proxy,
  }))
  // AGY 的 search_web 工具接入 dsh 搜索框架:searchProvider 配置为 'agy' 即启用。
  const searchProviderId = config.searchProviderId ?? 'agy'
  if (searchProviderId !== '' && ctx.web !== undefined) {
    ctx.web.registerSearchProvider(new AgySearchProvider({
      command: config.command ?? 'agy',
      model: config.model ?? 'gemini-3.7-flash-high',
      effort: config.effort ?? 'high',
      proxy: config.proxy,
    }))
  }
  // 设置面板 AntiGravity 配置区 + /agy 命令(status/test/help)。
  registerAgySettings(ctx)
}
