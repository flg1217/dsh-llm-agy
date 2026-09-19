/**
 * agy-executor 测试:agent.md 与 mcp_config.json 的幂等部署。
 * 用 DSH_TEST_HOME 风格不可行(os.homedir 直读),改用 vi.mock('node:os')。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let testHome = ''

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>()
  return { ...orig, homedir: () => testHome }
})

const { EXECUTOR_AGENT_MD, ensureDshMcpConfig, ensureExecutorAgent } = await import('../src/agy-executor.ts')

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'agy-exec-test-'))
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

describe('agy-executor:ensureExecutorAgent', () => {
  it('首次写入;内容一致时跳过;内容变化时覆写', () => {
    const file = join(testHome, '.gemini', 'antigravity-cli', 'agents', 'dsh-executor', 'agent.md')
    expect(ensureExecutorAgent()).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(EXECUTOR_AGENT_MD)
    expect(ensureExecutorAgent()).toBe(false)
    writeFileSync(file, 'stale content')
    expect(ensureExecutorAgent()).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(EXECUTOR_AGENT_MD)
  })
})

describe('agy-executor:ensureDshMcpConfig', () => {
  it('写入 dsh 条目且保留其它 MCP 服务器;同 URL 幂等', () => {
    const file = join(testHome, '.gemini', 'config', 'mcp_config.json')
    mkdirSync(join(testHome, '.gemini', 'config'), { recursive: true })
    writeFileSync(file, JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph' } } }))
    const url = 'http://127.0.0.1:3080/api/dsh-mcp?session=s1&key=k1'
    expect(ensureDshMcpConfig(url)).toBe(true)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      mcpServers?: { codegraph?: unknown; dsh?: { serverUrl?: string } }
    }
    expect(parsed.mcpServers?.codegraph).toEqual({ command: 'codegraph' })
    expect(parsed.mcpServers?.dsh?.serverUrl).toBe(url)
    expect(ensureDshMcpConfig(url)).toBe(false)
    expect(ensureDshMcpConfig(url.replace('k1', 'k2'))).toBe(true)
  })

  it('配置缺失时从零创建', () => {
    const file = join(testHome, '.gemini', 'config', 'mcp_config.json')
    const url = 'http://127.0.0.1:3080/api/dsh-mcp?session=s2&key=k'
    expect(ensureDshMcpConfig(url)).toBe(true)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: { dsh?: { serverUrl?: string } } }
    expect(parsed.mcpServers?.dsh?.serverUrl).toBe(url)
  })
})
