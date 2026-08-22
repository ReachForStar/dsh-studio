/**
 * Service Definition for the `ctx.ssh` capability seam: a settings-backed
 * connection-definition registry (the provider-independent part) plus the
 * live-connection contract providers implement. Definitions persist in the
 * `ssh` settings namespace; authentication secrets live in that same document
 * (harness home, shell-equivalent trust) and leave it only through the
 * secret-free views this package exports.
 * @module @deepseek-ai/dsh-ssh
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import {
  SshConnectionId,
  SshError,
  mergeAuthSecrets,
  normalizeDefinition,
  resolveDefinition,
  toDefinitionView,
} from './runtime.ts'
import type {
  SshConnection,
  SshConnectionDefinition,
  SshDefinitionView,
  SshExecRequest,
  SshExecSpec,
  SshSettingsSection,
  SshTestResult,
} from './types.ts'

export { SSH_CONNECT_TIMEOUT_MAX_MS, SSH_CONNECT_TIMEOUT_MIN_MS, SSH_DEFAULT_CONNECT_TIMEOUT_MS, SshConnectionId, SshError, mergeAuthSecrets, normalizeHostKeyFingerprint } from './runtime.ts'
export type { SshAuthInput, SshDefinitionCandidate, SshSaveInput } from './runtime.ts'
export type {
  SftpEntry,
  SftpEntryType,
  SshAuth,
  SshConnection,
  SshConnectionDefinition,
  SshDefinitionView,
  SshErrorCode,
  SshExecRequest,
  SshExecSpec,
  SshRunResult,
  SshSftp,
  SshStoredDefinition,
  SshTestResult,
} from './types.ts'

/** Settings namespace of the connection-definition registry. */
export const SSH_SETTINGS_NAMESPACE = settingsNamespace('ssh')

const SshAuthSchema = z.union([
  z.object({
    kind: z.const('password'),
    password: z.string().role('secret'),
  }),
  z.object({
    kind: z.const('privateKey'),
    privateKeyPath: z.string(),
    passphrase: z.string().role('secret'),
  }),
])

/** At-rest schema of the definition registry section (ids unbranded on disk). */
export const SshSettingsSchema: z<SshSettingsSection> = z.object({
  connections: z.array(z.object({
    id: z.string(),
    name: z.string(),
    host: z.string(),
    port: z.natural().max(65535),
    username: z.string(),
    auth: SshAuthSchema,
    connectTimeoutMs: z.natural().max(300_000),
    hostKeyFingerprint: z.string(),
  })).default([]),
  knownHosts: z.dict(z.string()).default({}),
})

const EMPTY_SECTION: SshSettingsSection = { connections: [], knownHosts: {} }

declare module '@deepseek-ai/cordis' {
  interface Context {
    ssh: SshService
  }
}

/**
 * Abstract SSH/SFTP service. The base class owns the settings-backed definition
 * registry (list/get/save/remove and the compose-able {@link test}); providers
 * implement {@link connect} and {@link resolveExec}. Mount exactly one provider
 * per context (a second registration throws, cordis' standard duplicate-service
 * behavior). Requires a settings provider: the registry's document is the
 * `ssh` settings namespace.
 */
export abstract class SshService extends Service {
  /** The registry document lives in user settings; the fiber waits for it. */
  static inject = ['settings']

  private scope: SettingsScope<SshSettingsSection> | undefined

  constructor(ctx: Context) {
    super(ctx, 'ssh')
    ctx.effect(() => {
      const scope = ctx.settings.register(SSH_SETTINGS_NAMESPACE, SshSettingsSchema)
      this.scope = scope
      return () => {
        this.scope = undefined
      }
    }, 'ssh: definition registry settings section')
  }

  /**
   * Read the current registry contents (frozen snapshots; never mutate).
   * @returns every saved definition in registry order.
   */
  list(): readonly SshConnectionDefinition[] {
    return this.readDefinitions()
  }

  /**
   * Look one definition up by id or unique name.
   * @param ref - the id or name to find.
   * @returns the definition, or undefined when no connection matches.
   */
  get(ref: SshConnectionId | string): SshConnectionDefinition | undefined {
    const found = this.readDefinitions().find(definition => definition.id === ref || definition.name === ref)
    return found
  }

  /**
   * Save one definition: an input carrying `id` updates that connection
   * (which must exist), otherwise a new connection is created. Names are
   * unique across the registry. An update whose auth omits a secret field
   * (password, privateKeyPath, passphrase) inherits the stored value, so
   * write-only callers can never wipe a secret they never saw.
   * @param input - untrusted save input (tool and wire payloads included).
   * @returns the normalized, persisted definition.
   */
  async save(input: unknown): Promise<SshConnectionDefinition> {
    const { definition: candidate, providedId } = normalizeDefinition(input)
    const current = this.readDefinitions()
    if (current.some(candidateEntry => candidateEntry.name === candidate.name && candidateEntry.id !== candidate.id)) {
      throw new SshError('SSH_NAME_EXISTS', `ssh connection name "${candidate.name}" already exists`)
    }
    const existing = providedId ? current.find(entry => entry.id === candidate.id) : undefined
    if (providedId && existing === undefined) {
      throw new SshError('SSH_NOT_FOUND', `ssh connection "${String(candidate.id)}" does not exist; save without an id to create one`)
    }
    const definition = existing === undefined ? candidate as SshConnectionDefinition : mergeAuthSecrets(existing, candidate)
    const next = existing === undefined
      ? [...current, definition]
      : current.map(entry => entry.id === definition.id ? definition : entry)
    await this.scopeOrThrow().update({ connections: next })
    return definition
  }

  /**
   * Remove one connection by id or name.
   * @param ref - the id or name to remove.
   * @returns whether a connection was removed.
   */
  async remove(ref: SshConnectionId | string): Promise<boolean> {
    const current = this.readDefinitions()
    const next = current.filter(candidate => candidate.id !== ref && candidate.name !== ref)
    if (next.length === current.length) return false
    await this.scopeOrThrow().update({ connections: next })
    return true
  }

  /**
   * Read the remembered host key fingerprint of one `host:port` endpoint.
   * @param hostPort - the endpoint key (e.g. `example.com:22`).
   * @returns the remembered `SHA256:<base64>` fingerprint, or undefined.
   */
  knownHostFingerprint(hostPort: string): string | undefined {
    return this.scopeOrThrow().get().knownHosts[hostPort]
  }

  /**
   * Persist a host key fingerprint for one `host:port` endpoint (the
   * accept-new side of host key verification).
   * @param hostPort - the endpoint key (e.g. `example.com:22`).
   * @param fingerprint - the `SHA256:<base64>` fingerprint to remember.
   */
  async rememberHostKey(hostPort: string, fingerprint: string): Promise<void> {
    const scope = this.scopeOrThrow()
    const section = scope.get()
    if (section.knownHosts[hostPort] === fingerprint) return
    await scope.update({ knownHosts: { ...section.knownHosts, [hostPort]: fingerprint } })
  }

  /**
   * Open (or reuse) the shared connection for one definition id. Handles stay
   * open until {@link close} or provider teardown.
   * @param id - the definition id to connect.
   * @returns the live connection handle.
   */
  abstract connect(id: SshConnectionId): Promise<SshConnection>

  /**
   * Close and evict the shared connection for one definition id.
   * @param id - the definition id to disconnect; unknown ids are a no-op.
   */
  abstract close(id: SshConnectionId): Promise<void>

  /**
   * Apply implementation-owned defaults and caps to an exec request.
   * @param request - the caller's request; omitted fields get this
   *   implementation's defaults, capped fields are clamped.
   * @returns the fully-specified spec to hand to {@link SshConnection.exec}.
   */
  abstract resolveExec(request: SshExecRequest): SshExecSpec

  /**
   * Verify that a connection definition can be reached: open its shared
   * connection, run a probe command, and close it again. The close evicts the
   * shared handle, so a concurrent user reconnects on its next call.
   * @param ref - the id or name to test.
   * @returns the successful probe with its round-trip latency.
   * @throws {@link SshError} with `SSH_NOT_FOUND` or `SSH_CONNECT_FAILED`.
   */
  async test(ref: SshConnectionId | string): Promise<SshTestResult> {
    const definition = this.get(ref)
    if (definition === undefined) {
      throw new SshError('SSH_NOT_FOUND', `ssh connection "${String(ref)}" is not defined`)
    }
    const started = Date.now()
    const connection = await this.connect(definition.id)
    try {
      // `echo ok` works on both POSIX shells and Windows cmd.
      const result = await connection.exec(this.resolveExec({ command: 'echo ok' }))
      if (result.exitCode !== 0 || result.timedOut || result.aborted) {
        throw new SshError('SSH_CONNECT_FAILED', `ssh probe command failed (exit ${String(result.exitCode)})`)
      }
      return { ok: true, latencyMs: Date.now() - started }
    } finally {
      await connection.close()
    }
  }

  /**
   * Project one definition to its secret-free wire view.
   * @param definition - the definition to project.
   * @returns the secret-free view for wire surfaces.
   */
  toView(definition: SshConnectionDefinition): SshDefinitionView {
    return toDefinitionView(definition)
  }

  /**
   * Resolve a caller reference (id or unique name) against the registry.
   * @param ref - the id or name to find.
   * @returns the matched definition.
   * @throws {@link SshError} with `SSH_NOT_FOUND` when nothing matches.
   */
  resolve(ref: SshConnectionId | string): SshConnectionDefinition {
    return resolveDefinition(this.readDefinitions(), ref)
  }

  private scopeOrThrow(): SettingsScope<SshSettingsSection> {
    const scope = this.scope
    if (scope === undefined) {
      throw new Error('ssh definition registry is not ready (settings section not registered)')
    }
    return scope
  }

  private readDefinitions(): readonly SshConnectionDefinition[] {
    const section = this.scope?.get() ?? EMPTY_SECTION
    return section.connections.map((entry) => {
      const { hostKeyFingerprint: rawFingerprint, ...rest } = entry
      return {
        ...rest,
        id: SshConnectionId(entry.id),
        ...rawFingerprint !== undefined && rawFingerprint !== null ? { hostKeyFingerprint: rawFingerprint } : {},
      }
    })
  }
}

export default SshService
