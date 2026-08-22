/**
 * Wire-independent SSH/SFTP vocabulary of the `ctx.ssh` capability seam.
 * @module @deepseek-ai/dsh-ssh/types
 */

import type { SshConnectionId } from './runtime.ts'

/** Stable identity of one saved connection definition. */
export type { SshConnectionId }

/** Authentication material of one connection. */
export type SshAuth =
  | { kind: 'password'; password: string }
  | { kind: 'privateKey'; privateKeyPath: string; passphrase?: string }

/** The durable connection-definition unit the registry stores. */
export interface SshConnectionDefinition {
  id: SshConnectionId
  /** Unique display name; also accepted wherever an id is. */
  name: string
  host: string
  port: number
  username: string
  auth: SshAuth
  /** Connection establishment timeout in milliseconds. */
  connectTimeoutMs: number
  /**
   * Expected host key fingerprint (`SHA256:<base64>`), pinning the server key
   * against man-in-the-middle substitution. Absent uses the remembered
   * known-hosts entry (accept-new) or rejects when none exists.
   */
  hostKeyFingerprint?: string | undefined
}

/** Secret-free view of a definition for wire surfaces. */
export interface SshDefinitionView {
  id: SshConnectionId
  name: string
  host: string
  port: number
  username: string
  auth:
    | { kind: 'password'; passwordSet: boolean }
    | { kind: 'privateKey'; privateKeyPath: string; passphraseSet: boolean }
  connectTimeoutMs: number
  /** Expected host key fingerprint, when the definition pins one. */
  hostKeyFingerprint?: string | undefined
}

/** A caller's execution request; provider-owned resolve fills the defaults. */
export interface SshExecRequest {
  command: string
  /** Timeout override in milliseconds (providers cap it). */
  timeoutMs?: number
  /** Remote working directory; the provider prefixes a `cd` to the command. */
  cwd?: string
  /** Abort signal — providers kill the command when it fires. */
  signal?: AbortSignal
}

/** A resolved execution spec produced by {@link SshService.resolveExec}. */
export interface SshExecSpec {
  command: string
  timeoutMs: number
  /** Remote working directory; absent keeps the login shell's cwd. */
  cwd?: string
  /** Abort signal — providers kill the command when it fires. */
  signal?: AbortSignal
  /** Resolved per-stream capture budget in bytes; overflow truncates to the tail. */
  outputMaxBytes: number
}

/** Outcome of one completed (or killed) remote command. */
export interface SshRunResult {
  /** Exit code; null when the stream closed without a remote exit status. */
  exitCode: number | null
  /** Terminating signal name (e.g. 'SIGKILL'); null on normal exit. */
  signal: string | null
  /** True when the provider's own deadline cut the command short first. */
  timedOut: boolean
  /** True when the caller's AbortSignal cut the command short first. */
  aborted: boolean
  /** The effective timeout applied to this run (after defaulting/capping). */
  timeoutMs: number
  stdout: string
  stdoutTruncated: boolean
  stderr: string
  stderrTruncated: boolean
  /** Wall time of the exec round-trip. */
  durationMs: number
}

/** Kind of one remote directory entry. */
export type SftpEntryType = 'file' | 'dir' | 'symlink' | 'other'

/** One remote directory entry or stat result. */
export interface SftpEntry {
  name: string
  type: SftpEntryType
  size: number
  /** Modification time in epoch milliseconds. */
  mtimeMs: number
  /** POSIX mode bits (type bits included). */
  mode: number
  /** Numeric owner id, when the server reported one. */
  owner?: string
  /** Numeric group id, when the server reported one. */
  group?: string
}

/** Outcome of {@link SshService.test}. */
export interface SshTestResult {
  ok: true
  /** Wall time of the connect + probe round-trip. */
  latencyMs: number
}

/** Stable machine codes of {@link SshError}. */
export type SshErrorCode =
  | 'SSH_NOT_FOUND'
  | 'SSH_NAME_EXISTS'
  | 'SSH_INVALID_DEFINITION'
  | 'SSH_CONNECT_FAILED'
  | 'SSH_AUTH_FAILED'
  | 'SSH_HOST_KEY_MISMATCH'
  | 'SSH_HOST_KEY_UNKNOWN'
  | 'SSH_CLOSED'
  | 'SSH_EXEC_FAILED'
  | 'SSH_SFTP_FAILED'
  | 'SSH_LOCAL_IO'

/** The at-rest settings section of the definition registry (ids unbranded on disk). */
export interface SshStoredDefinition {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: SshAuth
  connectTimeoutMs: number
  /** At-rest value may be null (schemastery's empty representation). */
  hostKeyFingerprint?: string | null
}

/** The at-rest settings section of the definition registry. */
export interface SshSettingsSection {
  connections: SshStoredDefinition[]
  /** Remembered host keys: `host:port` → `SHA256:<base64>` fingerprint. */
  knownHosts: Record<string, string>
}

/** SFTP operations of one live connection. */
export interface SshSftp {
  /** List one remote directory (non-recursive). */
  list(path: string): Promise<SftpEntry[]>
  /** Stat one remote path without following symlinks. */
  stat(path: string): Promise<SftpEntry>
  /**
   * Download one remote file to a local path. The local file must not exist
   * unless `overwrite` is set; a failed transfer removes the partial local file.
   */
  readFile(remotePath: string, localPath: string, options?: { overwrite?: boolean }): Promise<{ bytes: number }>
  /** Upload one local file to a remote path. */
  writeFile(localPath: string, remotePath: string): Promise<{ bytes: number }>
  /** Create one remote directory; `recursive` creates missing parents. */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  /** Remove one remote file, or one directory tree when `recursive` is set. */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  /** Rename or move one remote path. */
  rename(fromPath: string, toPath: string): Promise<void>
}

/**
 * One live remote connection handle. Handles returned by {@link SshService.connect}
 * are shared per definition id and remain open until {@link SshService.close} or
 * provider teardown; {@link close} on a shared handle evicts it for every user.
 */
export interface SshConnection {
  readonly id: SshConnectionId
  /** Run one foreground command; nonzero exits resolve with a result, not a rejection. */
  exec(spec: SshExecSpec): Promise<SshRunResult>
  readonly sftp: SshSftp
  /** Close the underlying channel; idempotent. */
  close(): Promise<void>
}
