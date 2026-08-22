/**
 * Runtime helpers of the SSH capability: the branded id, the typed error, and
 * the pure definition normalization/view functions the registry, tools, and
 * wire gateways share.
 * @module @deepseek-ai/dsh-ssh/runtime
 */

import { randomUUID } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  SshAuth,
  SshConnectionDefinition,
  SshDefinitionView,
  SshErrorCode,
} from './types.ts'

/** Stable identity of one saved connection definition. */
export type SshConnectionId = Branded<'SshConnectionId'>

/**
 * Brand a raw string as a connection id at an owning boundary.
 * @param value - the raw id string.
 * @returns the branded connection id.
 */
export function SshConnectionId(value: string): SshConnectionId {
  return value as SshConnectionId
}

/** Typed error of the SSH capability; `code` is stable across wire layers. */
export class SshError extends Error {
  /** Stable machine code (see {@link SshErrorCode}). */
  readonly code: SshErrorCode

  /**
   * @param code - stable machine code (see {@link SshErrorCode}).
   * @param message - human-readable explanation.
   */
  constructor(code: SshErrorCode, message: string) {
    super(message)
    this.name = 'SshError'
    this.code = code
  }
}

/**
 * Accepted auth material of a save input. Secret fields are optional so a
 * write-only update (a wire or tool payload that never saw the stored value)
 * can omit them; {@link SshService.save} merges the stored secret in. A
 * create must supply every required field.
 */
export type SshAuthInput =
  | { kind: 'password'; password?: string }
  | { kind: 'privateKey'; privateKeyPath?: string; passphrase?: string }

/** Accepted definition input: `id` present updates that definition, absent creates one. */
export interface SshSaveInput {
  id?: SshConnectionId
  name: string
  host: string
  port?: number
  username: string
  auth: SshAuthInput
  connectTimeoutMs?: number
  /** Expected host key fingerprint (`SHA256:<base64>`), when pinning. */
  hostKeyFingerprint?: string | undefined
}

/** The normalized candidate before stored-secret merging. */
export interface SshDefinitionCandidate {
  id: SshConnectionId
  name: string
  host: string
  port: number
  username: string
  auth: SshAuthInput
  connectTimeoutMs: number
  hostKeyFingerprint?: string | undefined
}

/** Accepted `SHA256:<base64>` host key fingerprint. */
const HOST_KEY_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}=?$/

/**
 * Validate one host key fingerprint at any boundary.
 * @param value - the candidate fingerprint (absent/empty clears it).
 * @returns the normalized fingerprint, or undefined when absent.
 */
export function normalizeHostKeyFingerprint(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !HOST_KEY_FINGERPRINT_PATTERN.test(value)) {
    invalid('ssh definition hostKeyFingerprint must be a "SHA256:<base64>" fingerprint')
  }
  return value
}

/** Default connection-establishment timeout applied when a save omits it. */
export const SSH_DEFAULT_CONNECT_TIMEOUT_MS = 10_000
/** Validated range of the connection-establishment timeout. */
export const SSH_CONNECT_TIMEOUT_MIN_MS = 1_000
/** Upper bound of the validated connection-establishment timeout range. */
export const SSH_CONNECT_TIMEOUT_MAX_MS = 300_000

function invalid(message: string): never {
  throw new SshError('SSH_INVALID_DEFINITION', message)
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`ssh definition ${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) invalid(`ssh definition ${field} must be non-empty`)
  return trimmed
}

function validAuth(value: unknown, providedId: boolean): SshAuthInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('ssh definition auth must be an object')
  }
  const record = value as Record<string, unknown>
  if (record['kind'] === 'password') {
    const password = record['password']
    if (password !== undefined && typeof password !== 'string') {
      invalid('ssh definition password must be a string')
    }
    if (!providedId && (typeof password !== 'string' || password.length === 0)) {
      invalid('ssh definition password auth requires a non-empty password')
    }
    return {
      kind: 'password',
      ...typeof password === 'string' && password.length > 0 ? { password } : {},
    }
  }
  if (record['kind'] === 'privateKey') {
    const privateKeyPath = record['privateKeyPath']
    if (privateKeyPath !== undefined && typeof privateKeyPath !== 'string') {
      invalid('ssh definition privateKeyPath must be a string')
    }
    if (!providedId && (typeof privateKeyPath !== 'string' || privateKeyPath.trim().length === 0)) {
      invalid('ssh definition privateKey auth requires a non-empty privateKeyPath')
    }
    const passphrase = record['passphrase']
    if (passphrase !== undefined && typeof passphrase !== 'string') {
      invalid('ssh definition passphrase must be a string')
    }
    return {
      kind: 'privateKey',
      ...typeof privateKeyPath === 'string' && privateKeyPath.trim().length > 0 ? { privateKeyPath: privateKeyPath.trim() } : {},
      ...typeof passphrase === 'string' && passphrase.length > 0 ? { passphrase } : {},
    }
  }
  invalid('ssh definition auth.kind must be "password" or "privateKey"')
}

/**
 * Validate and normalize one save input at any boundary. `id` absent mints a
 * fresh id; the result is the exact definition the registry stores, except
 * that secret fields omitted on an update stay absent — the registry merges
 * the stored values in {@link SshService.save}.
 * @param input - untrusted save input (wire or tool payloads included).
 * @returns the normalized candidate plus whether the caller supplied an id.
 */
export function normalizeDefinition(input: unknown): { definition: SshDefinitionCandidate; providedId: boolean } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid('ssh definition must be an object')
  }
  const record = input as Record<string, unknown>
  const idValue = record['id']
  const providedId = idValue !== undefined && idValue !== null && idValue !== ''
  if (providedId && typeof idValue !== 'string') invalid('ssh definition id must be a string')
  const name = nonEmptyString(record['name'], 'name')
  const host = nonEmptyString(record['host'], 'host')
  const username = nonEmptyString(record['username'], 'username')
  const portValue = record['port'] ?? 22
  if (typeof portValue !== 'number' || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    invalid(`ssh definition port must be an integer in [1, 65535], got ${JSON.stringify(portValue)}`)
  }
  const connectTimeoutValue = record['connectTimeoutMs'] ?? SSH_DEFAULT_CONNECT_TIMEOUT_MS
  if (typeof connectTimeoutValue !== 'number'
    || !Number.isInteger(connectTimeoutValue)
    || connectTimeoutValue < SSH_CONNECT_TIMEOUT_MIN_MS
    || connectTimeoutValue > SSH_CONNECT_TIMEOUT_MAX_MS) {
    invalid('ssh definition connectTimeoutMs must be an integer in '
      + `[${SSH_CONNECT_TIMEOUT_MIN_MS}, ${SSH_CONNECT_TIMEOUT_MAX_MS}], got ${JSON.stringify(connectTimeoutValue)}`)
  }
  return {
    definition: {
      id: providedId ? SshConnectionId(idValue) : SshConnectionId(randomUUID()),
      name,
      host,
      port: portValue,
      username,
      auth: validAuth(record['auth'], providedId),
      connectTimeoutMs: connectTimeoutValue,
      ...normalizeHostKeyFingerprint(record['hostKeyFingerprint']) !== undefined
        ? { hostKeyFingerprint: normalizeHostKeyFingerprint(record['hostKeyFingerprint']) }
        : {},
    },
    providedId,
  }
}

/**
 * Merge stored secrets into an updated candidate: when the incoming auth kind
 * matches the stored one, every omitted field (password, privateKeyPath,
 * passphrase) inherits the stored value, so a write-only update can never
 * wipe a secret it never saw. A kind switch keeps the incoming (complete)
 * auth as-is.
 * @param existing - the stored definition being updated.
 * @param candidate - the normalized incoming candidate.
 * @returns the complete definition to persist.
 */
export function mergeAuthSecrets(existing: SshConnectionDefinition, candidate: SshDefinitionCandidate): SshConnectionDefinition {
  const incoming = candidate.auth
  if (incoming.kind === 'password' && existing.auth.kind === 'password') {
    return {
      ...candidate,
      auth: { kind: 'password', password: incoming.password ?? existing.auth.password },
    }
  }
  if (incoming.kind === 'privateKey' && existing.auth.kind === 'privateKey') {
    return {
      ...candidate,
      auth: {
        kind: 'privateKey',
        privateKeyPath: incoming.privateKeyPath ?? existing.auth.privateKeyPath,
        ...(incoming.passphrase ?? existing.auth.passphrase) !== undefined
          ? { passphrase: incoming.passphrase ?? existing.auth.passphrase }
          : {},
      },
    }
  }
  return {
    ...candidate,
    auth: incoming as SshAuth,
  }
}

/**
 * Project one definition to its secret-free wire view.
 * @param definition - the definition to project.
 * @returns the secret-free view for wire surfaces.
 */
export function toDefinitionView(definition: SshConnectionDefinition): SshDefinitionView {
  return {
    id: definition.id,
    name: definition.name,
    host: definition.host,
    port: definition.port,
    username: definition.username,
    auth: definition.auth.kind === 'password'
      ? { kind: 'password', passwordSet: true }
      : {
        kind: 'privateKey',
        privateKeyPath: definition.auth.privateKeyPath,
        passphraseSet: definition.auth.passphrase !== undefined && definition.auth.passphrase.length > 0,
      },
    connectTimeoutMs: definition.connectTimeoutMs,
    ...definition.hostKeyFingerprint !== undefined ? { hostKeyFingerprint: definition.hostKeyFingerprint } : {},
  }
}

/**
 * Resolve a caller reference (id or unique name) against one definition list.
 * @param definitions - the candidates to search.
 * @param ref - the id or name to find.
 * @returns the matched definition.
 */
export function resolveDefinition(
  definitions: readonly SshConnectionDefinition[],
  ref: string | SshConnectionId,
): SshConnectionDefinition {
  const found = definitions.find(definition => definition.id === ref || definition.name === ref)
  if (found === undefined) {
    throw new SshError('SSH_NOT_FOUND', `ssh connection "${String(ref)}" is not defined`)
  }
  return found
}
