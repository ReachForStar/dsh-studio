/**
 * Wire vocabulary of the SSH connection-management gateway. Secrets are
 * write-only: a saved request may carry a password or passphrase, but every
 * response reports only whether one is set. Shapes are deliberately flat (no
 * nested unions) for the generated Remote schemas.
 * @module @deepseek-ai/dsh-host-ssh-remotes/types
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
