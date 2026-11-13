/**
 * Sharing key for pooled MCP connections.
 *
 * The key names every input that makes two connections behave differently, so
 * only identical ones share a transport. Server identity stays out: each
 * instance keeps its own tool namespace on the shared connection.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { Config } from './index.ts'
import { oauthSettings } from './oauth.ts'

/**
 * Fingerprint a set of transport values so no resolved secret sits in a map
 * key or a diagnostic. Entries are ordered by name, which is not secret.
 * @param values - environment or header values from the resolved configuration.
 * @returns the hexadecimal SHA-256 digest.
 */
function fingerprint(values: Record<string, string>): string {
  return fingerprintText(JSON.stringify(Object.entries(values).toSorted(([left], [right]) => left.localeCompare(right))))
}

/**
 * Fingerprint one transport value so a resolved secret stays out of a key.
 * @param text - value to hash.
 * @returns the hexadecimal SHA-256 digest.
 */
function fingerprintText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Compute the sharing key for one resolved configuration.
 *
 * Values from `${credential:…}` expansion are part of the key as resolved
 * values: two instances that resolve to the same bytes connect identically and
 * share, while a rotation produces a different key and therefore a new
 * connection. Reconnect policy, per-call timeouts, and instruction limits stay
 * per holder and do not change the connection, so they are absent.
 * @param config - configuration after credential expansion.
 * @returns a stable key; identical connections share it.
 */
export function poolKey(config: Config): string {
  const budgets = [config.startupTimeoutMs ?? null, config.closeTimeoutMs]
  if (config.transport === 'stdio') {
    return JSON.stringify(['stdio', config.command, config.args, config.cwd, fingerprint(config.env), ...budgets])
  }
  // The OAuth client decides which account a shared connection acts as, so two
  // configurations that authorize differently must not share one connection.
  const settings = oauthSettings(config)
  const oauth = settings === undefined
    ? null
    : {
      clientId: settings.clientId ?? null,
      clientSecret: settings.clientSecret === undefined ? null : fingerprintText(settings.clientSecret),
      scope: settings.scope ?? null,
    }
  return JSON.stringify(['streamable-http', config.url, fingerprint(config.headers), oauth, ...budgets])
}
