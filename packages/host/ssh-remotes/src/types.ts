/**
 * Wire vocabulary of the SSH connection-management gateway. Secrets are
 * write-only: a saved request may carry a password or passphrase, but every
 * response reports only whether one is set. Shapes are deliberately flat (no
 * nested unions) for the generated Remote schemas.
 * @module @reachforstar/dsh-host-ssh-remotes/types
 */

/** One connection definition as the browser may read it. */
export interface SshRemoteDefinition {
  id: string
  name: string
  host: string
  port: number
  username: string
  authKind: 'password' | 'privateKey'
  passwordSet: boolean
  /** Absolute private-key path; null unless `authKind` is `privateKey`. */
  privateKeyPath: string | null
  passphraseSet: boolean
  connectTimeoutMs: number
}

/** Save payload: `id` present updates that connection, absent creates one. */
export interface SshRemoteSaveRequest {
  id?: string
  name: string
  host: string
  port?: number
  username: string
  authKind: 'password' | 'privateKey'
  /** Write-only: absent keeps the stored password. */
  password?: string
  privateKeyPath?: string
  /** Write-only: absent keeps the stored passphrase. */
  passphrase?: string
  connectTimeoutMs?: number
}

/** Outcome of the connectivity probe. */
export interface SshRemoteTestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

/** 远程命令执行请求。 */
export interface SshExecRemoteRequest {
  connectionId: string
  command: string
  timeoutMs?: number
  cwd?: string
}

/** Remote command result returned to the browser. */
export interface SshRemoteRunResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: string
  stdoutTruncated: boolean
  stderr: string
  stderrTruncated: boolean
  durationMs: number
}

/** PTY open request. */
export interface SshPtyOpenRequest {
  connectionId: string
  cols: number
  rows: number
}

/** PTY attach request. */
export interface SshPtyAttachRequest {
  ptyId: string
}

/** PTY write request. */
export interface SshPtyWriteRequest {
  ptyId: string
  data: string
}

/** PTY resize request. */
export interface SshPtyResizeRequest {
  ptyId: string
  cols: number
  rows: number
}

/** PTY close request. */
export interface SshPtyCloseRequest {
  ptyId: string
}

/** SFTP path request. */
export interface SshSftpRequest {
  connectionId: string
  path: string
}

/** SFTP rename request. */
export interface SshSftpRenameRequest extends SshSftpRequest {
  toPath: string
}

/** SFTP 删除请求。 */
export interface SshSftpRemoveRequest extends SshSftpRequest {
  recursive?: boolean
}

/** SFTP directory creation request. */
export interface SshSftpMkdirRequest extends SshSftpRequest {
  recursive?: boolean
}

/** PTY event payload forwarded through the application event stream. */
export interface SshPtyOutputEvent {
  ptyId: string
  data: string
}

/** PTY exit event payload forwarded through the application event stream. */
export interface SshPtyExitEvent {
  ptyId: string
  exitCode: number | null
  signal: string | null
  dropped: boolean
}

/** Browser-facing SFTP directory entry. */
export interface SftpEntryView {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mtime: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One PTY output chunk, base64-encoded for JSON transport.
     * @param event - PTY identity and output bytes.
     * @mode emit
     */
    'ssh/pty/output'(event: SshPtyOutputEvent): void
    /**
     * One PTY termination report.
     * @param event - PTY identity and exit details.
     * @mode emit
     */
    'ssh/pty/exit'(event: SshPtyExitEvent): void
  }
}
