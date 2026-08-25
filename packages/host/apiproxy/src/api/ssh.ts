/**
 * ssh domain contract: interactive PTY sessions and streaming SFTP operations
 * over a named SSH connection. The browser owns the xterm.js and SFTP file
 * manager UI; the host owns the connection lifecycle, secrets, and the
 * remote filesystem. Secrets never cross the wire — the client selects a
 * connection by id and the host resolves the stored definition.
 *
 * PTY output and exit travel on the host frame stream (`ssh/pty/output` and
 * `ssh/pty/exit` frames in {@link HostFrame}); PTY input and control travel
 * as unary RPC methods. SFTP file transfer uses the host-only download
 * channel (GET, streamed) and a carrier POST upload route (streamed).
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One available SSH connection (secrets redacted). */
export interface SshConnectionView {
  /** Stable id the client uses to select the connection. */
  id: string
  /** Display name. */
  name: string
  /** Remote host. */
  host: string
  /** Remote port. */
  port: number
  /** Remote user. */
  user: string
  /** Auth kind (password or privateKey). */
  authKind: 'password' | 'privateKey'
}

/** One remote directory entry or stat result. */
export interface SftpEntryView {
  /** Base name. */
  name: string
  /** Full remote path. */
  path: string
  /** Entry type. */
  type: 'file' | 'directory' | 'symlink' | 'other'
  /** Size in bytes (0 for directories). */
  size: number
  /** Last-modified timestamp (epoch ms). */
  mtime: number
}

/** ssh.pty.open request payload. */
export interface SshPtyOpenRequest {
  /** The connection id to open the PTY on. */
  connectionId: string
  /** Terminal columns. */
  cols: number
  /** Terminal rows. */
  rows: number
  /** Optional working directory on the remote. */
  cwd?: string
}

/** ssh.pty.open response value. */
export interface SshPtyOpenResult {
  /** Opaque PTY session id (host-generated, branded). */
  ptyId: string
}

/** ssh.pty.write request payload. */
export interface SshPtyWriteRequest {
  /** The PTY session id. */
  ptyId: string
  /** UTF-8 terminal input bytes (base64-encoded on the wire). */
  data: string
}

/** ssh.pty.resize request payload. */
export interface SshPtyResizeRequest {
  /** The PTY session id. */
  ptyId: string
  /** New terminal columns. */
  cols: number
  /** New terminal rows. */
  rows: number
}

/** ssh.pty.close request payload. */
export interface SshPtyCloseRequest {
  /** The PTY session id. */
  ptyId: string
}

/** ssh.sftp.* request payload (shared). */
export interface SshSftpRequest {
  /** The connection id to operate on. */
  connectionId: string
  /** Remote path (absolute). */
  path: string
}

/** ssh.sftp.mkdir request payload. */
export interface SshSftpMkdirRequest extends SshSftpRequest {
  /** Whether to create parent directories. */
  recursive?: boolean
}

/** ssh.exec request payload. */
export interface SshExecRequest {
  /** The connection id to run the command on. */
  connectionId: string
  /** The remote command to run. */
  command: string
  /** Optional remote working directory. */
  cwd?: string
  /** Timeout override in milliseconds. */
  timeoutMs?: number
}

/** ssh.exec response value. */
export interface SshExecResult {
  /** Exit code; null when the stream closed without a remote exit status. */
  exitCode: number | null
  /** Terminating signal name (e.g. 'SIGKILL'); null on normal exit. */
  signal: string | null
  /** True when the provider's own deadline cut the command short first. */
  timedOut: boolean
  /** True when the caller's AbortSignal cut the command short first. */
  aborted: boolean
  stdout: string
  stderr: string
}

/** ssh.sftp.rename request payload. */
export interface SshSftpRenameRequest extends SshSftpRequest {
  /** New remote path. */
  toPath: string
}

/** ssh.sftp.remove request payload. */
export interface SshSftpRemoveRequest extends SshSftpRequest {
  /** Whether to remove a directory recursively. */
  recursive?: boolean
}

/** Host-level SSH methods: interactive PTY + streaming SFTP. */
export interface SshApi {
  /**
   * List the stored SSH connections (secrets redacted). The client uses this
   * to populate the connection selector.
   */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ connections: SshConnectionView[] }>>

  /**
   * Open an interactive PTY session on the named connection. The PTY output
   * and exit travel on the host frame stream; input and control travel as
   * unary RPC methods.
   */
  ptyOpen(
    request: RpcRequest<SshPtyOpenRequest>,
    signal: AbortSignal,
  ): Promise<RpcResponse<SshPtyOpenResult>>

  /**
   * Write terminal input bytes to a PTY session. The carrier passes its
   * request signal; the host forwards it to the SSH channel.
   */
  ptyWrite(
    request: RpcRequest<SshPtyWriteRequest>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ accepted: true }>>

  /**
   * Resize the PTY window.
   */
  ptyResize(
    request: RpcRequest<SshPtyResizeRequest>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ accepted: true }>>

  /**
   * Close a PTY session locally. The remote exit (if any) still travels on
   * the host frame stream.
   */
  ptyClose(
    request: RpcRequest<SshPtyCloseRequest>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ closed: true }>>

  /**
   * List one remote directory. Returns the entries sorted by name.
   */
  sftpList(
    request: RpcRequest<SshSftpRequest>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ entries: SftpEntryView[] }>>

  /**
   * Stat a single remote path (file or directory).
   */
  sftpStat(
    request: RpcRequest<SshSftpRequest>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ entry: SftpEntryView }>>

  /**
   * Create a remote directory.
   */
  sftpMkdir(
    request: RpcRequest<SshSftpMkdirRequest>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ path: string }>>

  /**
   * Remove a remote file or directory (recursive removes a directory tree).
   */
  sftpRemove(
    request: RpcRequest<SshSftpRemoveRequest>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ removed: true }>>

  /**
   * Rename (or move) a remote file or directory.
   */
  sftpRename(
    request: RpcRequest<SshSftpRenameRequest>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ path: string }>>

  /**
   * Run one foreground command on the named connection. Use for lightweight
   * probes such as resolving the remote home directory; interactive sessions
   * go through {@link ptyOpen}.
   */
  exec(
    request: RpcRequest<SshExecRequest>,
    signal: AbortSignal,
  ): Promise<RpcResponse<SshExecResult>>

  /**
   * Stream one remote file as an attachment response (host-only GET, no wire
   * envelope). The carrier's GET route answers this directly.
   * @param connectionId - the connection id.
   * @param remotePath - the remote file path.
   * @param signal - cancellation for the underlying read.
   * @returns the file attachment response.
   */
  sftpDownload(
    connectionId: string,
    remotePath: string,
    signal: AbortSignal,
  ): Promise<Response>

  /**
   * Upload one file to a remote path (carrier POST, no wire envelope).
   * @param connectionId - the connection id.
   * @param remotePath - the remote file path.
   * @param body - the request body (the file bytes).
   * @param signal - cancellation for the underlying write.
   * @returns a JSON response with the byte count.
   */
  sftpUpload(
    connectionId: string,
    remotePath: string,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<Response>
}
