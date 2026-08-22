/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-ssh-remotes`.
 * @module @deepseek-ai/dsh-host-ssh-remotes/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-ssh-remotes'

/** Cordis companion plugin name. */
export const name = 'ssh-remotes-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the gateway is a thin projection of the `ctx.ssh`
 * seam; the registry contracts it serves belong to the `dsh-ssh` companion.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
