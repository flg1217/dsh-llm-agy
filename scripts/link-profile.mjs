#!/usr/bin/env node
/**
 * link-profile:把插件安装(link)进一个 dsh profile。
 * 用法:node scripts/link-profile.mjs [--profile web]
 * 等价于官方 `dsh plugin --profile <name> add <dir>`。
 * lib/ 已随仓库提交,clone 后无需构建即可直接装配。
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(scriptDir, '..')
const profile = process.argv.includes('--profile')
  ? process.argv[process.argv.indexOf('--profile') + 1]
  : 'web'

console.log(`link-profile: adding ${pkgDir} to profile "${profile}"`)
execFileSync('npx', ['@deepseek-ai/dsh', 'plugin', '--profile', profile, 'add', pkgDir], {
  stdio: 'inherit',
  shell: true,
})
console.log('link-profile: done. Restart dsh web for the bundle layer to load.')
