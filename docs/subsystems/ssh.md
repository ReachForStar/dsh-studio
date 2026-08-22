# SSH / SFTP

English | [中文](ssh.zh.md)

The SSH/SFTP capability seam spans a Service Definition ([dsh-ssh](../../packages/remote/ssh), `ctx.ssh`), Service Provider ([dsh-ssh-local](../../packages/remote/ssh-local)), Consumer ([dsh-tool-ssh](../../packages/remote/tool-ssh), the twelve `ssh_*`/`sftp_*` schemas), and the Web GUI gateway ([dsh-host-ssh-remotes](../../packages/host/ssh-remotes)) with its Settings page ([dsh-client-ui-ssh](../../packages/client/ui-ssh)). Definitions and remembered host keys persist in the `ssh` settings namespace.

Source: [`packages/remote/ssh/src/types.ts`](../../packages/remote/ssh/src/types.ts)

## Definition registry

The service owns a settings-backed registry of `SshConnectionDefinition`s: id (branded), unique name, host, port, username, authentication (`password` | `privateKey` with optional passphrase), connection timeout, and an optional pinned host-key fingerprint. A save input's `id` selects update semantics — the connection must exist, and secrets omitted by a write-only caller are inherited from the stored definition. `SshDefinitionView` is the secret-free wire projection.

## Connection handles

`connect(id)` returns the provider's shared handle per definition id; `close` evicts it. A handle exposes `exec(spec)` — a foreground command with bounded output and an owned timeout that kills the remote command — and `sftp`, the SFTP operation surface (list/stat/readFile/writeFile/mkdir/remove/rename).

## Request vs. spec: the `resolveExec()` split

The seam separates the model-facing request (optional `timeoutMs`/`cwd`/`signal`) from the fully-resolved `SshExecSpec` (those fields required, `outputMaxBytes` filled) via `ctx.ssh.resolveExec(request)` — the repo's "explicit > implicit at package boundaries" rule.

## Host key verification

Host keys verify by default: `accept-new` remembers an unknown key in the registry's `knownHosts` table on first contact and rejects later changes (`SSH_HOST_KEY_MISMATCH`); `reject` denies unknown keys (`SSH_HOST_KEY_UNKNOWN`); a definition's `hostKeyFingerprint` pin wins over the remembered table. The local provider's handshake restricts to modern algorithms (no CBC/arcfour ciphers, no SHA-1 MACs, no `ssh-rsa` host-key signatures) unless `allowLegacyAlgorithms` opts into ssh2 defaults.

## Error taxonomy

Typed `SshError` with stable codes: `SSH_NOT_FOUND`, `SSH_NAME_EXISTS`, `SSH_INVALID_DEFINITION`, `SSH_CONNECT_FAILED`, `SSH_AUTH_FAILED`, `SSH_HOST_KEY_MISMATCH`, `SSH_HOST_KEY_UNKNOWN`, `SSH_CLOSED`, `SSH_EXEC_FAILED`, `SSH_SFTP_FAILED`, `SSH_LOCAL_IO`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxssh--sshservice-abstract-seam"></a>

### `ctx.ssh` — `SshService` (abstract seam)

Abstract SSH/SFTP service. The base class owns the settings-backed definition registry (list/get/save/remove and the compose-able test); providers implement connect and resolveExec. Mount exactly one provider per context (a second registration throws, cordis' standard duplicate-service behavior). Requires a settings provider: the registry's document is the `ssh` settings namespace.

```ts cordis-catalog
/**
 * Read the current registry contents (frozen snapshots; never mutate).
 * @returns every saved definition in registry order.
 */
list(): readonly SshConnectionDefinition[]

/**
 * Look one definition up by id or unique name.
 * @param ref - the id or name to find.
 * @returns the definition, or undefined when no connection matches.
 */
get(ref: SshConnectionId | string): SshConnectionDefinition | undefined

/**
 * Save one definition: an input carrying `id` updates that connection
 * (which must exist), otherwise a new connection is created. Names are
 * unique across the registry. An update whose auth omits a secret field
 * (password, privateKeyPath, passphrase) inherits the stored value, so
 * write-only callers can never wipe a secret they never saw.
 * @param input - untrusted save input (tool and wire payloads included).
 * @returns the normalized, persisted definition.
 */
async save(input: unknown): Promise<SshConnectionDefinition>

/**
 * Remove one connection by id or name.
 * @param ref - the id or name to remove.
 * @returns whether a connection was removed.
 */
async remove(ref: SshConnectionId | string): Promise<boolean>

/**
 * Read the remembered host key fingerprint of one `host:port` endpoint.
 * @param hostPort - the endpoint key (e.g. `example.com:22`).
 * @returns the remembered `SHA256:<base64>` fingerprint, or undefined.
 */
knownHostFingerprint(hostPort: string): string | undefined

/**
 * Persist a host key fingerprint for one `host:port` endpoint (the
 * accept-new side of host key verification).
 * @param hostPort - the endpoint key (e.g. `example.com:22`).
 * @param fingerprint - the `SHA256:<base64>` fingerprint to remember.
 */
async rememberHostKey(hostPort: string, fingerprint: string): Promise<void>

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
async test(ref: SshConnectionId | string): Promise<SshTestResult>

/**
 * Project one definition to its secret-free wire view.
 * @param definition - the definition to project.
 * @returns the secret-free view for wire surfaces.
 */
toView(definition: SshConnectionDefinition): SshDefinitionView

/**
 * Resolve a caller reference (id or unique name) against the registry.
 * @param ref - the id or name to find.
 * @returns the matched definition.
 * @throws {@link SshError} with `SSH_NOT_FOUND` when nothing matches.
 */
resolve(ref: SshConnectionId | string): SshConnectionDefinition
```

Source: [`packages/remote/ssh/src/index.ts`](../../packages/remote/ssh/src/index.ts)
<!-- END GENERATED cordis-surface -->
