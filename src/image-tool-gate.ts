/**
 * 读图工具闸门(按模型模态分流)。
 *
 * 两条对称规则:
 * - **仅文本**(或能力未知)路由 → 禁 dsh 原生 `read_image`、指路 `read_image_agy`。
 *   原因:原生 read_image 要求模型声明图片输入,而 relay 为了让文本模型能用它
 *   会把模型伪声明为支持 image——于是调用成功、图片块进历史,下一次请求才被
 *   适配器硬拒(`pi-ai model "X" does not support image input`)。
 * - **多模态**路由 → 禁 `read_image_agy`、指路 `read_image`。AGY 的文字转述对
 *   能直接看图的模型是纯损失(细节丢失),图片本身进上下文才是正解。
 *
 * **真值判定只用 `imageCapable` 集合**(relay 包装器按原生声明填充),
 * **不看 `resolveModelInfo` 的返回值**——relay 会把纯文本路由伪声明成支持
 * image(image-paste.ts 的包装),拿返回值判会让两条规则全部失效。
 * 集合未命中时先探测一次(探测顺带填充集合),再查集合。
 *
 * 两条规则都可被设置里的「按模型模态分流读图工具」总开关关掉(关掉后只靠
 * 提示词引导,不硬拒)。
 * @module llm-agy/image-tool-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { isImageCapableRoute } from './image-paste.js'

/** 一次工具调用路由到的模型(provider + model)。 */
export interface RoutedModel {
  provider: string
  model: string
}

/**
 * 从 `tools/pre-execute` 的 exec 上取本次调用的路由模型。
 * 会话级选择(`session.requestHeader().config`)优先,回退 agent 默认 options。
 * @param exec - 工具执行上下文(只读所需字段)。
 * @returns 路由;两处都取不到时 undefined。
 */
export function routedModelOf(exec: unknown): RoutedModel | undefined {
  const agent = (exec as {
    agent?: {
      session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } }
      options?: { provider?: string; model?: string }
    }
  }).agent
  const routed = agent?.session?.requestHeader?.()?.config
  if (routed?.provider !== undefined && routed.provider.length > 0
    && routed.model !== undefined && routed.model.length > 0) {
    return { provider: routed.provider, model: routed.model }
  }
  if (agent?.options?.provider !== undefined && agent.options.provider.length > 0
    && agent.options.model !== undefined && agent.options.model.length > 0) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

/**
 * 真·多模态判定:只认 `imageCapable` 集合(原生声明)。
 * 未命中时探测一次 `resolveModelInfo`(探测顺带填充集合),再查集合;
 * **不使用探测返回值**(relay 伪声明会让它恒真)。
 * @param ctx - 插件上下文(取 llm 服务)。
 * @param target - 路由模型。
 * @returns 是否原生支持图片输入。
 */
export async function routeIsImageCapable(ctx: Context, target: RoutedModel): Promise<boolean> {
  if (isImageCapableRoute(target.provider, target.model)) return true
  try {
    const llm = ctx.llm as {
      resolveModelInfo?: (provider: string, model: string) => Promise<unknown>
    }
    await llm.resolveModelInfo?.(target.provider, target.model)
  } catch {
    /* 探测失败:按文本模型处理(与原闸门口径一致) */
  }
  return isImageCapableRoute(target.provider, target.model)
}

/** 仅文本路由禁原生 read_image 的理由(原文案,一字未改)。 */
function textOnlyReadImageReason(): string {
  return 'read_image is disabled while "使用 AGY 读取图片" is on and the routed model is text-only: '
    + 'its image block would be rejected on the next request. Call read_image_agy instead '
    + '(same file_path / attachment id, plus an optional `prompt` to steer what to look for).'
}

/** 多模态路由禁 read_image_agy 的理由(带指路与逃生口)。 */
function imageCapableAgyReason(target: RoutedModel): string {
  return `read_image_agy is disabled while the routed model (${target.provider}/${target.model}) natively accepts `
    + 'image input: call read_image instead — the image itself then enters your context (and is rendered as an '
    + 'image card), which is strictly better than an AGY transcription. If you deliberately want AGY to transcribe '
    + 'the image, turn off "按模型模态分流读图工具" in Settings → AntiGravity.'
}

/**
 * 安装读图工具闸门(幂等注册一次,内部每次调用热读开关)。
 * @param ctx - 插件上下文。
 * @param enabled - 读当前设置(每次调用求值,设置面板切换后即时生效)。
 * @returns 注销函数。
 */
export function installImageToolGate(ctx: Context, enabled: () => boolean): () => void {
  return ctx.on('tools/pre-execute', async (exec, next) => {
    const name = exec.name
    if (name !== 'read_image' && name !== 'read_image_agy') return next()
    if (!enabled()) return next()
    const target = routedModelOf(exec)
    const capable = target === undefined ? undefined : await routeIsImageCapable(ctx, target)
    if (name === 'read_image') {
      // 路由未知时维持旧口径(拒绝):无法证明模型能吃图片,就不让图片进历史。
      if (capable === true) return next()
      return { kind: 'deny', reason: textOnlyReadImageReason() }
    }
    // read_image_agy:只有确认多模态才拒(未知/仅文本都放行,AGY 转述是安全兜底)。
    if (target !== undefined && capable === true) {
      return { kind: 'deny', reason: imageCapableAgyReason(target) }
    }
    return next()
  })
}
