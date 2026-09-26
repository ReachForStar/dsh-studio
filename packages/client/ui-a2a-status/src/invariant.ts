/** 包级不变量伴生。@module @reachforstar/dsh-client-ui-a2a-status/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@reachforstar/dsh-client-ui-a2a-status'

/** Cordis 伴生插件名。 */
export const name = 'client-ui-a2a-status-invariant'
/** 伴生所需的服务。 */
export const inject = ['invariants']

/** 无运行时不变量：本包是 a2a-status Remote 网关的展示壳。 */
const install: InvariantInstaller = () => {}

/** 注册本包的不变量伴生。 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */