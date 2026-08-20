/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-excalidraw`.
 * @module @deepseek-ai/dsh-tool-excalidraw/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-excalidraw'

/** Cordis companion plugin name. */
export const name = 'tool-excalidraw-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the model-facing adapter holds no independent
 * lifecycle stream; execution relations are owned by the tools registry it
 * registers into, and the scene file it mutates is plain workspace data.
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
