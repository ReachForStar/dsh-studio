/**
 * 包级不变量伴生：a2a-status 网关是 ctx.get('a2aHost') 和 kafka-detect 的薄投影，
 * 无独立运行时不变量需要校验。
 * @module @reachforstar/dsh-a2a-status/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@reachforstar/dsh-a2a-status'

/** Cordis 伴生插件名。 */
export const name = 'a2a-status-invariant'
/** 伴生所需的服务。 */
export const inject = ['invariants']

/** 无运行时不变量：网关仅投影可选的 a2aHost 和 kafka 探测结果。 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的不变量伴生。
 * @param ctx - 携带不变量服务的 Cordis 上下文。
 * @returns 注册的销毁函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */