/**
 * AGY 设置区:
 * - AgySettings:面板可编辑字段的活引用(由 index.ts 导出的 Config schema 解析,
 *   profile 条目 id `llm-agy` 即设置命名空间)。
 * - 模型探测通道:客户端面板按钮走自建路由(见 models-route.ts);官方
 *   discoverModels 通道一并保留(settingsNs = 条目 id)。
 * @module llm-agy/settings
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

/** 设置命名空间 = profile 条目 id。 */
export const AGY_SETTINGS_NAMESPACE = 'llm-agy'

/** 面板可编辑字段(volatile 活引用;由 index.ts 的 Config schema 解析)。 */
export interface AgySettings {
  command: Volatile<string>
  model: Volatile<string>
  effort: Volatile<string>
  proxy: Volatile<string>
  delegationGuide: Volatile<boolean>
  readImageAgy: Volatile<boolean>
  searchOverride: Volatile<boolean>
  dshExecutor: Volatile<boolean>
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

/**
 * 注册模型探测通道(客户端面板按钮走自建路由,不落会话)。
 * @param ctx - 插件上下文。
 * @param settings - 面板字段活引用(命令/代理/模型实时读,面板改动即时生效)。
 */
export function registerAgySettings(ctx: Context, settings: AgySettings): void {
  // 模型探测通道:客户端 api.llm.discoverModels({settingsNs:'llm-agy', provider:'status'|'test'})
  // → 服务端直接 spawn agy CLI,返回结果(机制通用,语义伪装成 model 列表)。
  // 全程不落会话、不动源码。
  const llm = ctx.get('llm')
  if (llm !== undefined && typeof (llm as { registerModelDiscovery?: unknown }).registerModelDiscovery === 'function') {
    try {
    (llm as { registerModelDiscovery: (ns: string, fn: (request: { provider?: string }) => Promise<readonly { id: string; name?: string }[]>) => void })
      .registerModelDiscovery(AGY_SETTINGS_NAMESPACE, async (request: { provider?: string }) => {
        const command = settings.command.get() || 'agy'
        const proxy = settings.proxy.get() || 'http://127.0.0.1:7890'
        const model = settings.model.get() || 'gemini-3.7-flash-high'
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
          if (entries.length === 0) entries.push({ id: model, name: model })
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
    } catch (error) {
      // llm-agy 可能被多个 ctx(realm)apply;llm 服务对已注册 discovery 抛
      // DUPLICATE_DISCOVERY,根 ctx 已注册时后续 ctx 跳过即可。
      if ((error as { code?: string })?.code !== 'DUPLICATE_DISCOVERY') throw error
    }
  }
}
