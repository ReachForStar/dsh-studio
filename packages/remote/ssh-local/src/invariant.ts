/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ssh-local`.
 * @module @deepseek-ai/dsh-ssh-local/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ssh-local'

/** Cordis companion plugin name. */
export const name = 'ssh-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the connection cache is process-local state validated
 * at its own boundaries — the registry uniqueness contract lives in the
 * `dsh-ssh` companion, and a dropped client evicts itself through the same
 * close callback that guards every operation.
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
