/**
 * Host Remote gateway for the SSH connection-management GUI: list, save, and
 * remove definitions plus the connectivity probe, all over the `ctx.ssh` seam.
 * Secrets are write-only — every response is a secret-free view.
 * @module @deepseek-ai/dsh-host-ssh-remotes
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SshError } from '@deepseek-ai/dsh-ssh'
import type { SshConnectionDefinition } from '@deepseek-ai/dsh-ssh'
import type {
  SshRemoteDefinition,
  SshRemoteSaveRequest,
  SshRemoteTestResult,
} from './types.ts'

export type * from './types.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`ssh save: ${key} must be a non-empty string`)
  }
  return value.trim()
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`ssh save: ${key} must be a number`)
  }
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`ssh save: ${key} must be a string`)
  }
  return value
}

/**
 * Project one registry definition to its secret-free wire shape.
 * @param definition - the definition to project.
 * @returns the flat wire view the browser reads.
 */
export function toRemoteDefinition(definition: SshConnectionDefinition): SshRemoteDefinition {
  return {
    id: String(definition.id),
    name: definition.name,
    host: definition.host,
    port: definition.port,
    username: definition.username,
    authKind: definition.auth.kind,
    passwordSet: definition.auth.kind === 'password',
    privateKeyPath: definition.auth.kind === 'privateKey' ? definition.auth.privateKeyPath : null,
    passphraseSet: definition.auth.kind === 'privateKey'
      && definition.auth.passphrase !== undefined
      && definition.auth.passphrase.length > 0,
    connectTimeoutMs: definition.connectTimeoutMs,
  }
}

/**
 * Translate one validated wire request into a seam save input.
 * @param request - the validated wire payload.
 * @returns the save input handed to the seam.
 */
export function toSaveInput(request: SshRemoteSaveRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {
    name: request.name,
    host: request.host,
    username: request.username,
  }
  // Undefined fields are forwarded as absent: the seam keeps stored secrets.
  if (request.id !== undefined) input['id'] = request.id
  if (request.port !== undefined) input['port'] = request.port
  if (request.connectTimeoutMs !== undefined) input['connectTimeoutMs'] = request.connectTimeoutMs
  if (request.authKind === 'password') {
    input['auth'] = {
      kind: 'password',
      ...request.password !== undefined ? { password: request.password } : {},
    }
  } else {
    input['auth'] = {
      kind: 'privateKey',
      ...request.privateKeyPath !== undefined ? { privateKeyPath: request.privateKeyPath } : {},
      ...request.passphrase !== undefined ? { passphrase: request.passphrase } : {},
    }
  }
  return input
}

/**
 * Wire-boundary validation of a save payload. The browser may legitimately
 * omit a stored secret (write-only inputs), so `password`/`passphrase` are
 * forwarded as absent and the seam's save keeps the stored value.
 * @param value - untrusted wire payload.
 * @returns the validated save request.
 */
export function validateSaveRequest(value: unknown): SshRemoteSaveRequest {
  if (!isPlainObject(value)) throw new Error('ssh save: payload must be an object')
  const authKind = value['authKind']
  if (authKind !== 'password' && authKind !== 'privateKey') {
    throw new Error(`ssh save: authKind must be "password" or "privateKey", got ${JSON.stringify(authKind)}`)
  }
  const id = optionalString(value, 'id')
  if (id !== undefined && id.length === 0) throw new Error('ssh save: id must be non-empty')
  const port = optionalNumber(value, 'port')
  const connectTimeoutMs = optionalNumber(value, 'connectTimeoutMs')
  const password = optionalString(value, 'password')
  const privateKeyPath = optionalString(value, 'privateKeyPath')
  const passphrase = optionalString(value, 'passphrase')
  if (authKind === 'password' && password !== undefined && password.length === 0) {
    throw new Error('ssh save: password must be non-empty')
  }
  if (authKind === 'privateKey' && (privateKeyPath === undefined || privateKeyPath.length === 0)) {
    throw new Error('ssh save: privateKeyPath must be non-empty for privateKey auth')
  }
  const request: SshRemoteSaveRequest = {
    name: requireString(value, 'name'),
    host: requireString(value, 'host'),
    username: requireString(value, 'username'),
    authKind,
    ...id !== undefined ? { id } : {},
    ...port !== undefined ? { port } : {},
    ...connectTimeoutMs !== undefined ? { connectTimeoutMs } : {},
    ...password !== undefined && password.length > 0 ? { password } : {},
    ...privateKeyPath !== undefined && privateKeyPath.length > 0 ? { privateKeyPath } : {},
    ...passphrase !== undefined && passphrase.length > 0 ? { passphrase } : {},
  }
  return request
}

/** Connection-management Remote surface over the `ctx.ssh` seam. */
export class SshGateway extends TypertRemoteService {
  static inject = ['ssh']

  constructor(ctx: Context) {
    // The gateway is its own Cordis service (`sshGateway`) whose wire namespace
    // is `ssh` — the provider's registry key stays a same-process service.
    super(ctx, 'sshGateway', { namespace: 'ssh' })
  }

  /**
   * List every saved connection as a secret-free wire view.
   * @returns the current definition list, secret-free.
   */
  @Remote('list')
  list(): { connections: SshRemoteDefinition[] } {
    return { connections: this.ctx.ssh.list().map(toRemoteDefinition) }
  }

  /**
   * Save one connection definition (create or update by id). Secrets are
   * write-only: a request omitting `password`/`passphrase` keeps the stored
   * value for the addressed connection.
   * @param request - the wire payload (typert validates its shape).
   * @returns the saved secret-free wire view.
   */
  @Remote('save')
  async save(request: SshRemoteSaveRequest): Promise<SshRemoteDefinition> {
    const validated = validateSaveRequest(request)
    const saved = await this.ctx.ssh.save(toSaveInput(validated))
    return toRemoteDefinition(saved)
  }

  /**
   * Remove one connection definition.
   * @param id - the connection id to remove.
   * @returns whether a connection was removed.
   */
  @Remote('delete')
  async delete(id: string): Promise<{ removed: boolean }> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('ssh delete: id must be a non-empty string')
    }
    return { removed: await this.ctx.ssh.remove(id) }
  }

  /**
   * Probe one connection and report the outcome without throwing across the
   * wire: failures are a result, never an RPC error.
   * @param id - the connection id to test.
   * @returns the probe outcome.
   */
  @Remote('test')
  async test(id: string): Promise<SshRemoteTestResult> {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, error: 'ssh test: id must be a non-empty string' }
    }
    try {
      const outcome = await this.ctx.ssh.test(id)
      return { ok: outcome.ok, latencyMs: outcome.latencyMs }
    } catch (error) {
      const message = error instanceof SshError ? error.message : error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  }
}

export default SshGateway
