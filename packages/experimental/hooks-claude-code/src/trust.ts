/**
 * Durable per-project trust for a discovered hook configuration. The record
 * binds one project directory to the exact content digest the person approved,
 * so editing the file invalidates the grant until it is approved again.
 * @module @deepseek-ai/dsh-hooks-claude-code/trust
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** One approved project hook configuration. */
export interface ProjectHookTrust {
  /** SHA-256 of the exact file bytes the person approved. */
  readonly digest: string
  /** Unix epoch milliseconds when the content was approved. */
  readonly trustedAt: number
}

const projectHookTrustSchema = z.object({
  digest: z.string().min(1),
  trustedAt: z.number().int().nonnegative(),
})

/**
 * The hook-trust domain: one `projects` table keyed by the exact session
 * working directory that owns the discovered configuration.
 */
export const projectHookTrustSpec = defineDomain({
  name: 'hook_trust',
  version: 1,
  tables: { projects: domainTable<string, ProjectHookTrust>(projectHookTrustSchema) },
})

/**
 * Digest the exact bytes of a hook configuration file. Byte-level hashing is
 * deliberate: a comment or whitespace edit changes what the person approved
 * even when the parsed groups would be identical.
 * @param raw - the file content as read from disk.
 * @returns the lowercase hexadecimal SHA-256 digest.
 */
export function digestHookConfig(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}
