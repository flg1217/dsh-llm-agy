/**
 * 读图工具闸门测试:
 * - 多模态路由:放行原生 read_image、拒 read_image_agy(指路 read_image);
 * - 仅文本路由:拒原生 read_image(指路 read_image_agy)、放行 read_image_agy;
 * - **relay 伪声明回归**:resolveModelInfo 的返回值被 relay 追加成含 image,
 *   闸门仍按仅文本处理(真值只认 imageCapable 集合);
 * - 路由解析不出 / 开关关闭 / 非读图工具:不拦。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installImageToolGate, routedModelOf } from '../src/image-tool-gate.ts'
import { installImageRelay } from '../src/image-paste.ts'

type Handler = (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>

/** 假 ctx:捕获 tools/pre-execute handler;llm.resolveModelInfo 按声明表返回。 */
function makeCtx(declared: Record<string, readonly string[]>) {
  const handlers = new Map<string, Handler>()
  const llm = {
    resolveModelInfo: async (provider: string, model: string) => ({
      provider,
      id: model,
      name: model,
      inputModalities: declared[`${provider}:${model}`] ?? ['text'],
    }),
    adapters: new Map(),
  }
  const ctx = {
    llm,
    get: (key: string) => (key === 'llm' ? llm : undefined),
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler)
      return () => { handlers.delete(event) }
    },
  } as unknown as Context
  return { ctx, llm, handlers }
}

const allow = async (): Promise<unknown> => ({ kind: 'enter' })

function execFor(name: string, route?: { provider: string; model: string }): unknown {
  return { name, agent: route === undefined ? undefined : { options: route } }
}

/** 探测一次路由的能力声明(等价于运行时首次 resolveModelInfo,relay 借此填充集合)。 */
async function declaredModalities(
  llm: { resolveModelInfo: (provider: string, model: string) => Promise<unknown> },
  provider: string,
  model: string,
): Promise<readonly string[]> {
  const info = await llm.resolveModelInfo(provider, model) as { inputModalities?: readonly string[] }
  return info.inputModalities ?? []
}

/**
 * 装好 relay + 闸门(与运行时同序):relay 填充 imageCapable 集合,
 * 闸门按集合判定。prime 里的路由会被探测一次(等价于运行时首次 resolveModelInfo)。
 */
async function setup(options: {
  declared: Record<string, readonly string[]>
  prime?: readonly string[]
  gateOn?: boolean
}) {
  const { ctx, llm, handlers } = makeCtx(options.declared)
  const disposeRelay = installImageRelay(ctx, () => ({ command: 'agy', proxy: '' }))
  for (const key of options.prime ?? []) {
    const [provider, model] = key.split(':')
    await declaredModalities(llm, provider!, model!)
  }
  const disposeGate = installImageToolGate(ctx, () => options.gateOn ?? true)
  const handler = handlers.get('tools/pre-execute')
  if (handler === undefined) throw new Error('闸门未注册 tools/pre-execute')
  return { handler, llm, disposeGate, disposeRelay: disposeRelay ?? (() => {}) }
}

describe('installImageToolGate(按模型模态分流)', () => {
  it('多模态路由:放行 read_image,拒 read_image_agy 并指路 read_image', async () => {
    const { handler } = await setup({ declared: { 'cb-multi:flash': ['text', 'image'] }, prime: ['cb-multi:flash'] })
    const route = { provider: 'cb-multi', model: 'flash' }
    expect(await handler(execFor('read_image', route), allow)).toEqual({ kind: 'enter' })
    const denied = await handler(execFor('read_image_agy', route), allow) as { kind: string; reason: string }
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('cb-multi/flash')
    expect(denied.reason).toContain('call read_image instead')
    expect(denied.reason).toContain('按模型模态分流读图工具')
  })

  it('仅文本路由:拒原生 read_image(指路 read_image_agy),放行 read_image_agy', async () => {
    const { handler, llm } = await setup({ declared: { 'cb-text:glm': ['text'] } })
    const route = { provider: 'cb-text', model: 'glm' }
    // relay 伪声明:返回值被追加成含 image(旧判定会据此放行原生工具,新判定不认)。
    expect(await declaredModalities(llm, 'cb-text', 'glm')).toContain('image')
    const denied = await handler(execFor('read_image', route), allow) as { kind: string; reason: string }
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('read_image_agy')
    expect(await handler(execFor('read_image_agy', route), allow)).toEqual({ kind: 'enter' })
  })

  it('relay 伪声明回归:探测返回值含 image,但集合为空 → 仍按仅文本判', async () => {
    const { handler, llm } = await setup({ declared: { 'cb-fake:glm': ['text'] } })
    const route = { provider: 'cb-fake', model: 'glm' }
    // 闸门内部探测后返回值确实含 image(伪声明生效)……
    expect(await declaredModalities(llm, 'cb-fake', 'glm')).toContain('image')
    // ……但判定只看集合:read_image 被拒、read_image_agy 放行。
    expect(((await handler(execFor('read_image', route), allow)) as { kind: string }).kind).toBe('deny')
    expect(await handler(execFor('read_image_agy', route), allow)).toEqual({ kind: 'enter' })
  })

  it('路由解析不出:read_image 维持旧口径(拒),read_image_agy 放行', async () => {
    const { handler } = await setup({ declared: {} })
    expect(((await handler(execFor('read_image'), allow)) as { kind: string }).kind).toBe('deny')
    expect(await handler(execFor('read_image_agy'), allow)).toEqual({ kind: 'enter' })
  })

  it('开关关闭:两条规则都不拦', async () => {
    const { handler } = await setup({
      declared: { 'cb-off:flash': ['text', 'image'], 'cb-off:glm': ['text'] },
      prime: ['cb-off:flash'],
      gateOn: false,
    })
    expect(await handler(execFor('read_image', { provider: 'cb-off', model: 'glm' }), allow)).toEqual({ kind: 'enter' })
    expect(await handler(execFor('read_image_agy', { provider: 'cb-off', model: 'flash' }), allow)).toEqual({ kind: 'enter' })
  })

  it('非读图工具直接放行', async () => {
    const { handler } = await setup({ declared: { 'cb-x:glm': ['text'] } })
    expect(await handler(execFor('read', { provider: 'cb-x', model: 'glm' }), allow)).toEqual({ kind: 'enter' })
  })
})

describe('routedModelOf', () => {
  it('会话级选择优先,回退 agent 默认,都无 → undefined', () => {
    expect(routedModelOf({
      agent: {
        session: { requestHeader: () => ({ config: { provider: 'p1', model: 'm1' } }) },
        options: { provider: 'p2', model: 'm2' },
      },
    })).toEqual({ provider: 'p1', model: 'm1' })
    expect(routedModelOf({ agent: { options: { provider: 'p2', model: 'm2' } } }))
      .toEqual({ provider: 'p2', model: 'm2' })
    expect(routedModelOf({ agent: {} })).toBeUndefined()
    expect(routedModelOf({})).toBeUndefined()
  })
})
