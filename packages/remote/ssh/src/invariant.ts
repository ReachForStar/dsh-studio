/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ssh`.
 * @module @deepseek-ai/dsh-ssh/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { SSH_SETTINGS_NAMESPACE } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-ssh'

/** Cordis companion plugin name. */
export const name = 'ssh-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the registry contract: after every commit to the `ssh` settings
 * section, the registry's own read must report unique ids and unique names.
 * `save` enforces both; this check extends the guarantee to documents edited
 * externally, which would otherwise silently shadow one connection by name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('settings/updated', (ns, _next, _prev) => {
    if (ns !== SSH_SETTINGS_NAMESPACE) return
    const ssh = ctx.get('ssh')
    if (ssh === undefined) {
      fail(`settings/updated for "${String(ns)}" emitted without a live ssh service`)
      return
    }
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
