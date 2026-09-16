/**
 * AGY 可用模型查询工具。
 *
 * AGY CLI 自带 `models` 子命令,输出 `id\t名称` 逐行(stdout);
 * "Fetching available models..." 等提示走 stderr,不影响解析。
 * 主代理先查询再以准确的 model id 委派。
 * @module llm-agy/models
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn, spawnSync } from 'node:child_process'

/** 解析 `agy models` 输出,返回模型 id + 名称列表文本。 */
export function listAgyModels(command: string): string {
  const r = spawnSync(command, ['models'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  })
  const lines = (r.stdout ?? '')
    .split('\n')
    .map((line: string) => line.replace(/\r$/, ''))
    .filter((line: string) => line.trim().length > 0)
  if (lines.length === 0) {
    const tail = (r.stderr ?? '').trim().split('\n').slice(-3).join('\n')
    return `\`${command} models\` returned nothing (exit ${r.status ?? '?'}). Stderr tail:\n${tail}`
  }
  return lines.map((line: string) => {
    const tab = line.indexOf('\t')
    if (tab === -1) return `- ${line.trim()}`
    const id = line.slice(0, tab).trim()
    const name = line.slice(tab + 1).trim()
    return `- ${id} — ${name}`
  }).join('\n')
}

/**
 * 异步查询 `agy models`,返回结构化条目(不阻塞事件循环,供设置面板路由)。
 * 失败/超时/解析不到时返回空数组。AGY CLI 需要代理出网(与适配器同款 env)。
 */
export async function listAgyModelEntriesAsync(
  command: string,
  opts: { timeoutMs?: number; proxy?: string } = {},
): Promise<Array<{ id: string; name?: string }>> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  return new Promise((resolve) => {
    let settled = false
    const finish = (entries: Array<{ id: string; name?: string }>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(entries)
    }
    let stdout = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, ['models'], {
        windowsHide: true,
        ...(opts.proxy
          ? { env: { ...process.env, HTTPS_PROXY: opts.proxy, HTTP_PROXY: opts.proxy, ALL_PROXY: opts.proxy } }
          : {}),
      })
    } catch {
      return resolve([])
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish([])
    }, timeoutMs)
    timer.unref?.()
    // UTF-8 流式解码:逐块 String() 会把跨 chunk 的多字节字符拆成乱码。
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.on('error', () => finish([]))
    child.on('close', () => {
      const entries = stdout
        .split('\n')
        .map((line: string) => line.replace(/\r$/, ''))
        .filter((line: string) => line.trim().length > 0)
        .map((line: string) => {
          const tab = line.indexOf('\t')
          if (tab === -1) return { id: line.trim() }
          return { id: line.slice(0, tab).trim(), name: line.slice(tab + 1).trim() }
        })
        .filter(entry => entry.id.length > 0)
      finish(entries)
    })
  })
}

/** 注册模型查询工具(与 subagent_agy_ui 配套)。 */
export function registerAgyModelsTool(
  ctx: Context,
  options: { command: string; toolName: string },
): void {
  ctx.tools.register(defineTool({
    name: options.toolName,
    description:
      'List the model ids currently supported by the AGY (Antigravity) CLI. Call this before delegating when you '
      + 'want a non-default model, then pass one of the returned ids in the `model` argument of subagent_agy_ui.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return listAgyModels(options.command)
    },
  }))
}
