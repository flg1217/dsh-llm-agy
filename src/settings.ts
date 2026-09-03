// @ts-nocheck -- TODO(专门轮):适配官方 0.1.2 的设置注册新 API;当前仅运行时降级保活。
/**
 * AGY 设置区:
 * - installSettingsSection 注册 `agy` namespace,设置面板自动出现 AntiGravity 配置表单。
 * - 模型探测通道:客户端面板按钮走 api.llm.discoverModels(状态/测试)。
 * @module llm-agy/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

export const AGY_SETTINGS_NAMESPACE = 'agy' as never

/** AGY 设置表单 schema(schemastery Schema;settings.register 会把 schema 当函数调用)。 */
export const AgySettingsConfig = z.object({
  command: z.string().default('agy').description('agy 可执行文件命令(默认 agy)'),
  model: z.string().default('gemini-3.7-flash-high').description('传给 --model 的 AGY 模型'),
  effort: z.string().default('high').description('推理强度 low/medium/high'),
  proxy: z.string().default('').description('AGY 流量代理(例如 http://127.0.0.1:7890;留空回落到插件配置的默认代理)'),
  /** 全局注入"子代理委派"系统提示(subagent_agy_ui 用途与委派规则)。 */
  delegationGuide: z.boolean().default(true).description('注入子代理委派提示词'),
  /** 是否注册 AGY 看图工具与图片粘贴中继(默认开启)。 */
  readImageAgy: z.boolean().default(true).description('使用 AGY 读取粘贴的图片'),
})

/** 读取 readImageAgy 开关(默认开启)。 */
export function readImageAgyEnabled(ctx: Context): boolean {
  const settings = ctx.get('settings') as { get?: (ns: string) => { readImageAgy?: boolean } | undefined } | undefined
  return settings?.get?.('agy')?.readImageAgy ?? true
}

/** 检测 AGY 是否已安装(命令存在)。 */
export function agyInstalled(command: string): boolean {
  const r = spawnSync(command, ['--version'], { stdio: 'ignore', windowsHide: true })
  return r.error === undefined
}

/**
 * 检测 AGY 登录状态。
 * 注意:`agy auth status` 不是有效命令(会挂起),不能用于检测。
 * 可靠依据:AGY 数据目录存在 + 已有会话记录(说明完成过登录与使用)。
 */
export function agyLoggedIn(): boolean {
  const base = join(process.env.USERPROFILE ?? '', '.gemini', 'antigravity-cli')
  if (!existsSync(base)) return false
  // 有会话记录 = 已登录使用过;cli.log 有成功活动也可佐证。
  const conversations = join(base, 'conversations')
  if (existsSync(conversations)) {
    try {
      return readdirSync(conversations).length > 0
    } catch { /* 目录读失败按未登录 */ }
  }
  return false
}

/** 发起真实测试:让 AGY 回答一个真实问题,返回实际回复内容。 */
export function agyTest(command: string, proxy: string): Promise<{ ok: boolean; output: string }> {
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
    })
    let out = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (d: string) => { out += d })
    const killer = setTimeout(() => proc.kill(), 60_000)
    proc.on('close', (code: number | null) => {
      clearTimeout(killer)
      const text = out.trim()
      resolve({ ok: code === 0 && text.length > 0, output: text || `exit ${code}` })
    })
    proc.on('error', (err: Error) => {
      clearTimeout(killer)
      resolve({ ok: false, output: String(err) })
    })
  })
}

/** 注册设置区与模型探测通道(客户端面板按钮走 api.llm.discoverModels,不落会话)。 */
export async function registerAgySettings(ctx: Context): Promise<() => Record<string, string>> {
  let current: () => Record<string, unknown> = () => ({})
  // TODO(专门轮):官方 0.1.2 移除 installSettingsSection,待适配新注册协议;
  // 当前设置区不注册(功能降级),仅保留读取通道与模型探测回退。
  try {
    const { installSettingsSection } = await import('@deepseek-ai/dsh-settings') as {
      installSettingsSection?: (ctx: Context, ns: unknown, schema: unknown, defaults: unknown, hooks: unknown) => void
    }
    if (installSettingsSection !== undefined) {
      installSettingsSection(ctx, AGY_SETTINGS_NAMESPACE, AgySettingsConfig, {}, {
        setSource: (source) => { current = source as () => Record<string, unknown> },
        onChange: () => {},
      })
    }
  } catch { /* 新版 dsh-settings 无此 API:跳过注册,功能降级 */ }
  const sectionOf = () => current() as Record<string, string>

  // 模型探测通道:客户端 api.llm.discoverModels({settingsNs:'agy', provider:'status'|'test'})
  // → 服务端直接 spawn agy CLI,返回结果(机制通用,语义伪装成 model 列表)。
  // 全程不落会话、不动源码。
  const llm = ctx.get('llm')
  if (llm !== undefined && typeof (llm as { registerModelDiscovery?: unknown }).registerModelDiscovery === 'function') {
    (llm as { registerModelDiscovery: (ns: string, fn: (request: { provider?: string }) => Promise<readonly { id: string; name?: string }[]>) => void })
      .registerModelDiscovery(AGY_SETTINGS_NAMESPACE, async (request: { provider?: string }) => {
        const section = sectionOf()
        const command = section.command ?? 'agy'
        const proxy = section.proxy ?? 'http://127.0.0.1:7890'
        const action = request.provider ?? 'status'
        if (action === 'models') {
          // 列出 AGY 可用模型:解析 `agy models` 输出(id + 显示名两列)。
          const r = spawnSync(command, ['models'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
          const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
          const entries: { id: string; name: string }[] = []
          for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (trimmed === '' || trimmed.startsWith('Fetching')) continue
            const m = trimmed.match(/^(\S+)\s+(.+)$/)
            if (m !== null) entries.push({ id: m[1], name: `${m[1]}  ${m[2]}` })
          }
          // 解析失败/无结果时回落到当前默认,避免弹窗空白
          if (entries.length === 0) entries.push({ id: section.model, name: section.model })
          return entries
        }
        if (action === 'test') {
          const { ok, output } = await agyTest(command, proxy)
          return [{
            id: 'agy-test',
            // 展示 AGY 的真实回复内容(而非固定 hi);name 必须非空(客户端网关 min(1) 校验)。
            name: ok ? (output.slice(0, 300) || '(空回复)') : `✗ AGY 测试失败:${output.slice(0, 300)}`,
          }]
        }
        const installed = agyInstalled(command)
        const loggedIn = installed && agyLoggedIn()
        return [{
          id: 'agy-status',
          name: `AGY 安装:${installed ? '✓ 已安装' : '✗ 未安装'} | 登录状态:${installed ? (loggedIn ? '✓ 已登录' : '✗ 未登录') : '-'} | 命令:${command}`,
        }]
      })
  }
  return sectionOf
}
