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
import { spawnSync } from 'node:child_process'

/** 解析 `agy models` 输出,返回模型 id + 名称列表文本。 */
export function listAgyModels(command: string): string {
  const r = spawnSync(command, ['models'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  })
  const lines = (r.stdout ?? '')
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(line => line.trim().length > 0)
  if (lines.length === 0) {
    const tail = (r.stderr ?? '').trim().split('\n').slice(-3).join('\n')
    return `\`${command} models\` returned nothing (exit ${r.status ?? '?'}). Stderr tail:\n${tail}`
  }
  return lines.map(line => {
    const tab = line.indexOf('\t')
    if (tab === -1) return `- ${line.trim()}`
    const id = line.slice(0, tab).trim()
    const name = line.slice(tab + 1).trim()
    return `- ${id} — ${name}`
  }).join('\n')
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
