/**
 * /api/llm-agy/models 路由测试(此前零覆盖)。
 *
 * 锁死的行为:
 * - 信任围栏:loopback/trustedHosts 放行,非可信 Host、cross-site 标记、
 *   跨源 Origin 一律 403;非 GET 405;
 * - 10 分钟内存缓存命中不再拉取;失败且无缓存时回 { ok:false };
 * - 进行中的慢查询被并发请求共享(只触发一次 agy models)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

const { entriesMock } = vi.hoisted(() => ({ entriesMock: vi.fn() }))
vi.mock('../src/models.ts', () => ({
  listAgyModelEntriesAsync: entriesMock,
}))

const { registerAgyModelsRoute } = await import('../src/models-route.ts')

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** 假请求。 */
function req(overrides?: { method?: string; headers?: Record<string, string> }): IncomingMessage {
  return {
    method: overrides?.method ?? 'GET',
    headers: { host: '127.0.0.1:3001', ...overrides?.headers },
  } as unknown as IncomingMessage
}

/** 假响应:记录状态码与响应体。 */
interface FakeRes {
  res: ServerResponse
  status: () => number
  body: () => string
}

function res(): FakeRes {
  let code = 0
  let payload = ''
  const r = {
    writeHead: (c: number) => { code = c; return r },
    end: (b?: string) => { payload = b ?? '' },
  }
  return { res: r as unknown as ServerResponse, status: () => code, body: () => payload }
}

/** 路由 handler 是 fire-and-forget(void handle):轮询等到响应真正写出。 */
async function waitDone(r: FakeRes, timeoutMs = 500): Promise<void> {
  const started = Date.now()
  while (r.status() === 0) {
    if (Date.now() - started > timeoutMs) throw new Error('route handler 未在超时内完成响应')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** 走完注册链路,捕获 handler。 */
function setup(trustedHosts: string[] = []): (r: IncomingMessage, s: ServerResponse) => Promise<void> {
  let handler: Handler | undefined
  let injectFn: ((injected: Context) => void) | undefined
  const ctx = {
    inject: (_deps: string[], fn: (injected: Context) => void) => { injectFn = fn },
  } as unknown as Context
  registerAgyModelsRoute(ctx, () => ({ command: 'agy', proxy: 'http://127.0.0.1:7890' }))
  injectFn?.({
    get: (key: string) => (key === 'webServer'
      ? { register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } }
      : key === 'webStartup' ? { trustedHosts } : undefined),
  } as unknown as Context)
  if (handler === undefined) throw new Error('handler 未注册')
  return async (r, s) => { await handler?.(r, s) }
}

/** 发起一次请求并等到响应写出。 */
async function call(handle: (r: IncomingMessage, s: ServerResponse) => Promise<void>, reqIn: IncomingMessage): Promise<FakeRes> {
  const r = res()
  await handle(reqIn, r.res)
  await waitDone(r)
  return r
}

beforeEach(() => {
  entriesMock.mockReset()
})

describe('models 路由:信任围栏', () => {
  it('loopback Host 放行,返回模型列表', async () => {
    entriesMock.mockResolvedValue({ entries: [{ id: 'gemini-3.8-high', name: 'G' }], stderrTail: '' })
    const r = await call(setup(), req())
    expect(r.status()).toBe(200)
    expect(JSON.parse(r.body())).toEqual({ ok: true, models: [{ id: 'gemini-3.8-high', name: 'G' }] })
  })

  it('非 loopback Host 且不在 trustedHosts → 403', async () => {
    const r = await call(setup(), req({ headers: { host: 'evil.example.com' } }))
    expect(r.status()).toBe(403)
    expect(entriesMock).not.toHaveBeenCalled()
  })

  it('trustedHosts 命中的 Host 放行', async () => {
    entriesMock.mockResolvedValue({ entries: [{ id: 'm' }], stderrTail: '' })
    const r = await call(setup(['mybox:3001']), req({ headers: { host: 'mybox:3001' } }))
    expect(r.status()).toBe(200)
  })

  it('cross-site 标记 / 跨源 Origin 一律 403', async () => {
    const handle = setup()
    for (const headers of [
      { host: '127.0.0.1:3001', 'sec-fetch-site': 'cross-site' },
      { host: '127.0.0.1:3001', origin: 'http://evil.example.com' },
    ]) {
      const r = await call(handle, req({ headers }))
      expect(r.status()).toBe(403)
    }
    expect(entriesMock).not.toHaveBeenCalled()
  })

  it('同源 Origin 放行;非 GET 405', async () => {
    entriesMock.mockResolvedValue({ entries: [{ id: 'm' }], stderrTail: '' })
    const handle = setup()
    const ok = await call(handle, req({ headers: { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001' } }))
    expect(ok.status()).toBe(200)

    const post = await call(handle, req({ method: 'POST' }))
    expect(post.status()).toBe(405)
  })
})

describe('models 路由:缓存与并发', () => {
  it('第二次请求命中缓存,不再拉取', async () => {
    entriesMock.mockResolvedValue({ entries: [{ id: 'm' }], stderrTail: '' })
    const handle = setup()
    await call(handle, req())
    const second = await call(handle, req())
    expect(entriesMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(second.body())).toMatchObject({ ok: true, cached: true })
  })

  it('失败且无缓存:回 { ok:false, error }', async () => {
    entriesMock.mockRejectedValue(new Error('agy models failed'))
    const r = await call(setup(), req())
    expect(JSON.parse(r.body())).toMatchObject({ ok: false, error: 'agy models failed' })
  })

  it('慢查询进行中:并发请求共享同一次拉取', async () => {
    let release: (value: { entries: Array<{ id: string }>; stderrTail: string }) => void = () => {}
    entriesMock.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const handle = setup()
    const first = res()
    const second = res()
    const p1 = handle(req(), first.res)
    const p2 = handle(req(), second.res)
    release({ entries: [{ id: 'm' }], stderrTail: '' })
    await Promise.all([p1, p2])
    await Promise.all([waitDone(first), waitDone(second)])
    expect(entriesMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(first.body())).toMatchObject({ ok: true })
    expect(JSON.parse(second.body())).toMatchObject({ ok: true })
  })
})
