/**
 * Package-owned invariant companion for `@reachforstar/dsh-ssh`.
 * @module @reachforstar/dsh-ssh/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Type-only: pulls the settings Events merge (settings/document-updated).
import type {} from '@deepseek-ai/dsh-settings'

const PACKAGE_NAME = '@reachforstar/dsh-ssh'

/** Cordis companion plugin name. */
export const name = 'ssh-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the registry contract: after any settings document commit that could
 * carry the registry, the live registry's own read must report unique ids and
 * unique names. `save` enforces both; this check extends the guarantee to
 * profile documents edited externally, which would otherwise silently shadow
 * one connection by name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('settings/document-updated', () => {
    const ssh = ctx.get('sshSftp')
    // No live registry to validate; a provider that is not mounted owns no ids.
    if (ssh === undefined) return
    const definitions = ssh.list()
    const ids = new Set(definitions.map(definition => definition.id))
    if (ids.size !== definitions.length) {
      fail('ssh registry holds duplicate connection ids')
    }
    const names = new Set(definitions.map(definition => definition.name))
    if (names.size !== definitions.length) {
      fail('ssh registry holds duplicate connection names')
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
