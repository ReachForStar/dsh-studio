# SSH / SFTP

[English](ssh.md) | 中文

SSH/SFTP 能力接缝横跨 Service Definition（[dsh-ssh](../../packages/remote/ssh)，`ctx.ssh`）、Service Provider（[dsh-ssh-local](../../packages/remote/ssh-local)）、Consumer（[dsh-tool-ssh](../../packages/remote/tool-ssh)，十二个 `ssh_*`/`sftp_*` schema）与 Web GUI 网关（[dsh-host-ssh-remotes](../../packages/host/ssh-remotes)）及其设置页（[dsh-client-ui-ssh](../../packages/client/ui-ssh)）。定义与记住的主机密钥持久化在 `ssh` settings 命名空间。

Source: [`packages/remote/ssh/src/types.ts`](../../packages/remote/ssh/src/types.ts)

## 定义注册表

服务拥有 settings 支撑的 `SshConnectionDefinition` 注册表：id（品牌化）、唯一名称、主机、端口、用户名、认证（`password` | 含可选口令的 `privateKey`）、连接超时与可选钉扎主机密钥指纹。save 输入的 `id` 决定更新语义——连接必须存在，只写调用方省略的秘密从存储定义继承。`SshDefinitionView` 是无秘密的 wire 投影。

## 连接句柄

`connect(id)` 返回 provider 按定义 id 的共享句柄；`close` 逐出。句柄暴露 `exec(spec)`——有界输出与自有超时（会杀掉远程命令）的前台命令——与 `sftp`（list/stat/readFile/writeFile/mkdir/remove/rename）。

## 请求与 spec：`resolveExec()` 拆分

接缝分离模型面请求（可选 `timeoutMs`/`cwd`/`signal`）与完整解析的 `SshExecSpec`（这些字段必填，`outputMaxBytes` 已填充），经 `ctx.ssh.resolveExec(request)`——仓库的「包边界显式优于隐式」规则。

## 主机密钥校验

主机密钥默认校验：`accept-new` 首连把未知密钥记入注册表的 `knownHosts` 表、后续变更拒绝（`SSH_HOST_KEY_MISMATCH`）；`reject` 拒绝未知密钥（`SSH_HOST_KEY_UNKNOWN`）；定义上的 `hostKeyFingerprint` 钉扎优先于记住表。本地 provider 的握手限定现代算法（无 CBC/arcfour 加密、无 SHA-1 MAC、无 `ssh-rsa` 主机密钥签名），除非 `allowLegacyAlgorithms` 退回 ssh2 默认。

## 错误分类

带稳定码的类型化 `SshError`：`SSH_NOT_FOUND`、`SSH_NAME_EXISTS`、`SSH_INVALID_DEFINITION`、`SSH_CONNECT_FAILED`、`SSH_AUTH_FAILED`、`SSH_HOST_KEY_MISMATCH`、`SSH_HOST_KEY_UNKNOWN`、`SSH_CLOSED`、`SSH_EXEC_FAILED`、`SSH_SFTP_FAILED`、`SSH_LOCAL_IO`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
