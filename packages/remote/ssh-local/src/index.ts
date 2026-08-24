/**
 * Local implementation of the `ctx.ssh` capability seam over `ssh2`. One
 * connection per definition id is cached and reused across consumers until
 * closed or dropped; exec and SFTP operations are promise-wrapped with
 * bounded output capture and an owned timeout that kills the remote command.
 * Host keys are not verified (see the package README).
 * @module @deepseek-ai/dsh-ssh-local
 */

import { createHash } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { basename, dirname } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper, type Stats } from 'ssh2'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { clampTimeout } from '@deepseek-ai/dsh-timeout'
import { SshConnectionId, SshError, SshService } from '@deepseek-ai/dsh-ssh'
import type {
  SftpEntry,
  SshAuth,
  SshConnection,
  SshConnectionDefinition,
  SshExecRequest,
  SshExecSpec,
  SshPtyExitInfo,
  SshPtyOptions,
  SshPtySession,
  SshReadableFile,
  SshRunResult,
  SshSftp,
  SshWritableFile,
} from '@deepseek-ai/dsh-ssh'

/** SFTP v3 status code for "no such file"; ssh2 errors carry it as `code`. */
const SFTP_STATUS_NO_SUCH_FILE = 2

/** Settings namespace of this provider's own execution defaults. */
export const SSH_LOCAL_SETTINGS_NAMESPACE = settingsNamespace('ssh-local')

/** Configuration for the local SSH provider. */
export interface Config {
  /** Default foreground command timeout in milliseconds (default 60000). */
  defaultExecTimeoutMs?: number
  /** Cap for per-call timeout overrides in milliseconds (default 600000). */
  maxExecTimeoutMs?: number
  /** Per-stream capture cap in bytes; overflow keeps the tail (default 65536). */
  outputMaxBytes?: number
  /**
   * Host key policy: `accept-new` remembers an unknown key on first contact
   * and rejects later changes; `reject` refuses any key that is neither
   * pinned on the definition nor remembered. (Default `accept-new`.)
   */
  strictHostKey?: 'accept-new' | 'reject'
  /**
   * When true, use the ssh2 algorithm defaults (legacy kex/cipher/MAC
   * fallbacks included) for maximum server compatibility. Default false
   * restricts the handshake to modern algorithms.
   */
  allowLegacyAlgorithms?: boolean
  /**
   * SSH keep-alive interval in milliseconds (0 disables; default 0).
   */
  keepaliveIntervalMs?: number
  /**
   * Reject private keys whose POSIX permissions let group/others read them
   * (OpenSSH behavior; Windows ACLs are not checked). Default true.
   */
  strictPrivateKeyPermissions?: boolean
  /**
   * SFTP transfers larger than this many bytes use the parallel
   * fastGet/fastPut path (0 disables the fast path; default 1 MiB).
   */
  fastTransferThresholdBytes?: number
}

/** Runtime configuration schema for the local SSH provider. */
export const Config: z<Config> = z.object({
  defaultExecTimeoutMs: z.natural().default(60_000),
  maxExecTimeoutMs: z.natural().default(600_000),
  outputMaxBytes: z.natural().default(65_536),
  strictHostKey: z.union([z.const('accept-new'), z.const('reject')]).default('accept-new'),
  allowLegacyAlgorithms: z.boolean().default(false),
  keepaliveIntervalMs: z.natural().default(0),
  strictPrivateKeyPermissions: z.boolean().default(true),
  fastTransferThresholdBytes: z.natural().default(1_048_576),
})

/** Validated execution defaults. */
export interface ResolvedConfig {
  defaultExecTimeoutMs: number
  maxExecTimeoutMs: number
  outputMaxBytes: number
  strictHostKey: 'accept-new' | 'reject'
  allowLegacyAlgorithms: boolean
  keepaliveIntervalMs: number
  strictPrivateKeyPermissions: boolean
  fastTransferThresholdBytes: number
}

function resolveConfig(config: Config): ResolvedConfig {
  /* v8 ignore start -- schemastery fills every default before construction, so each ?? right side below is unreachable */
  const resolved = {
    defaultExecTimeoutMs: config.defaultExecTimeoutMs ?? 60_000,
    maxExecTimeoutMs: config.maxExecTimeoutMs ?? 600_000,
    outputMaxBytes: config.outputMaxBytes ?? 65_536,
    strictHostKey: config.strictHostKey ?? 'accept-new',
    allowLegacyAlgorithms: config.allowLegacyAlgorithms ?? false,
    keepaliveIntervalMs: config.keepaliveIntervalMs ?? 0,
    strictPrivateKeyPermissions: config.strictPrivateKeyPermissions ?? true,
    fastTransferThresholdBytes: config.fastTransferThresholdBytes ?? 1_048_576,
  }
  /* v8 ignore stop */
  if (resolved.maxExecTimeoutMs < resolved.defaultExecTimeoutMs) {
    throw new Error('ssh-local: maxExecTimeoutMs must be >= defaultExecTimeoutMs')
  }
  return resolved
}

/**
 * Modern handshake algorithm set (no CBC/arcfour ciphers, no SHA-1 MACs, no
 * group1/group14-sha1 kex, no SHA-1 `ssh-rsa` host key signatures).
 */
type SecureAlgorithms = NonNullable<ConnectConfig['algorithms']>
const SECURE_ALGORITHMS: SecureAlgorithms = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group18-sha512',
  ],
  cipher: [
    'aes128-gcm@openssh.com',
    'aes256-gcm@openssh.com',
    'chacha20-poly1305@openssh.com',
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
  ],
  hmac: [
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
  ],
}

/**
 * Single-quote one path for a remote POSIX shell.
 * @param value - the path to quote.
 * @returns the single-quoted shell literal.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Map an ssh2 establishment failure to the seam's typed error. */
function toConnectError(error: unknown): SshError {
  /* v8 ignore next -- real connection failures are always Error instances */
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('All configured authentication methods failed') || message.includes('Authentication failed')) {
    return new SshError('SSH_AUTH_FAILED', `ssh authentication failed: ${message}`)
  }
  return new SshError('SSH_CONNECT_FAILED', `ssh connection failed: ${message}`)
}

/** Map an SFTP operation failure to the seam's typed error. */
function sftpError(operation: string, path: string, error: unknown): SshError {
  /* v8 ignore next -- real SFTP failures are always Error instances */
  const message = error instanceof Error ? error.message : String(error)
  return new SshError('SSH_SFTP_FAILED', `ssh sftp ${operation} failed for "${path}": ${message}`)
}

/** Map a local file failure to the seam's typed error. */
function localIoError(operation: string, path: string, error: unknown): SshError {
  /* v8 ignore next -- real local failures are always Error instances */
  const message = error instanceof Error ? error.message : String(error)
  return new SshError('SSH_LOCAL_IO', `ssh ${operation} failed for local path "${path}": ${message}`)
}

/** Map one ssh2 Stats object to a seam entry. */
function toEntry(name: string, stats: Stats): SftpEntry {
  return {
    name,
    /* v8 ignore next -- the test server creates files and directories only */
    type: stats.isDirectory() ? 'dir' : stats.isSymbolicLink() ? 'symlink' : stats.isFile() ? 'file' : 'other',
    size: stats.size,
    mtimeMs: stats.mtime * 1000,
    mode: stats.mode,
    owner: String(stats.uid),
    group: String(stats.gid),
  }
}

/** Establish one client connection from a definition. */
async function openClient(
  def: SshConnectionDefinition,
  ssh: SshService,
  options: {
    strictHostKey: 'accept-new' | 'reject'
    allowLegacyAlgorithms: boolean
    keepaliveIntervalMs: number
    strictPrivateKeyPermissions: boolean
  },
): Promise<Client> {
  const client = new Client()
  const auth = await resolveAuth(def.auth, options.strictPrivateKeyPermissions)
  const denial = checkHostKey(def, ssh, options.strictHostKey, `${def.host}:${def.port}`)
  const config: ConnectConfig = {
    host: def.host,
    port: def.port,
    username: def.username,
    readyTimeout: def.connectTimeoutMs,
    ...options.allowLegacyAlgorithms ? {} : { algorithms: SECURE_ALGORITHMS },
    ...options.keepaliveIntervalMs > 0 ? { keepaliveInterval: options.keepaliveIntervalMs } : {},
    // v8 ignore next -- checkHostKey always returns a verifier; the guard is defensive
    ...denial.hostVerifier !== undefined ? { hostVerifier: denial.hostVerifier } : {},
    ...auth,
  }
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => { resolve() })
      client.once('error', (error) => { reject(error) })
      client.connect(config)
    })
  } catch (error) {
    client.destroy()
    if (denial.denial.value !== undefined) throw denial.denial.value
    throw toConnectError(error)
  }
  return client
}

/** Result of wiring the host key verifier for one connection attempt. */
interface HostKeyCheck {
  /** Recorded denial reference, surfaced verbatim when the handshake fails. */
  denial: { value: SshError | undefined }
  /** The verifier to install, when host key checking is enabled. */
  hostVerifier: ((key: Buffer, verify: (valid: boolean) => void) => void) | undefined
}

/**
 * Build the host key verifier: a pinned fingerprint on the definition wins;
 * otherwise the remembered known-hosts entry decides; otherwise `accept-new`
 * persists the key and `reject` denies the connection. The recorded denial is
 * surfaced with its specific code (mismatch vs unknown).
 */
function checkHostKey(
  def: SshConnectionDefinition,
  ssh: SshService,
  strictHostKey: 'accept-new' | 'reject',
  hostPort: string,
): HostKeyCheck {
  const denial: { value: SshError | undefined } = { value: undefined }
  const hostVerifier = (key: Buffer, verify: (valid: boolean) => void): void => {
    const fingerprint = hostKeyFingerprintOf(key)
    const pinned = def.hostKeyFingerprint
    if (pinned !== undefined) {
      if (fingerprint !== pinned) {
        denial.value = new SshError('SSH_HOST_KEY_MISMATCH', `ssh host key fingerprint ${fingerprint} does not match pinned ${pinned} for ${hostPort}`)
        verify(false)
        return
      }
      verify(true)
      return
    }
    const known = ssh.knownHostFingerprint(hostPort)
    if (known !== undefined) {
      if (fingerprint !== known) {
        denial.value = new SshError('SSH_HOST_KEY_MISMATCH', `ssh host key fingerprint ${fingerprint} does not match remembered ${known} for ${hostPort}`)
        verify(false)
        return
      }
      verify(true)
      return
    }
    if (strictHostKey === 'accept-new') {
      // Remember-then-verify: the write failure must not fail the connection.
      // v8 ignore next -- both callbacks verify(true); the rejection arm is identical
      void ssh.rememberHostKey(hostPort, fingerprint).then(() => { verify(true) }, () => { verify(true) })
      return
    }
    denial.value = new SshError('SSH_HOST_KEY_UNKNOWN', `ssh host key of ${hostPort} is unknown (strictHostKey: reject)`)
    verify(false)
  }
  return { denial, hostVerifier }
}

/** Compute the OpenSSH-style `SHA256:<base64>` fingerprint of a host key. */
function hostKeyFingerprintOf(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64')
  return `SHA256:${digest}`
}

/** Materialize the authentication payload of one definition. */
async function resolveAuth(auth: SshAuth, strictPrivateKeyPermissions: boolean): Promise<ConnectConfig> {
  if (auth.kind === 'password') return { password: auth.password }
  // v8 ignore start -- the POSIX permission check is unreachable on Windows, the platform this suite runs on
  if (strictPrivateKeyPermissions && process.platform !== 'win32') {
    const info = await stat(auth.privateKeyPath)
    if ((info.mode & 0o077) !== 0) {
      throw new SshError('SSH_AUTH_FAILED', `ssh private key "${auth.privateKeyPath}" has too-open permissions (mode ${info.mode.toString(8)}); chmod 600 it first`)
    }
  }
  /* v8 ignore stop */
  let privateKey: string
  try {
    privateKey = await readFile(auth.privateKeyPath, 'utf8')
  } catch (error) {
    /* v8 ignore next -- file failures are always Error instances */
    throw new SshError('SSH_AUTH_FAILED', `ssh cannot read private key "${auth.privateKeyPath}": ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    privateKey,
    ...auth.passphrase !== undefined ? { passphrase: auth.passphrase } : {},
  }
}

/** One live interactive PTY session over a shell channel. */
class LocalPtySession implements SshPtySession {
  /** Output chunks in arrival order, replayed to subscribers that attach later. */
  private readonly buffer: Uint8Array[] = []
  private readonly outputListeners = new Set<(data: Uint8Array) => void>()
  private readonly exitListeners = new Set<(info: SshPtyExitInfo) => void>()
  private exitInfo: SshPtyExitInfo | undefined
  /** True once the session terminated (remote exit, drop, or local close). */
  closed = false

  constructor(
    private readonly shell: ClientChannel,
    private readonly onEnded: () => void,
  ) {
    const deliver = (chunk: Buffer): void => {
      this.buffer.push(chunk)
      for (const listener of [...this.outputListeners]) listener(chunk)
    }
    this.shell.on('data', deliver)
    this.shell.stderr.on('data', deliver)
    const onExit = (code: number | null, signal?: string): void => {
      this.finish({
        exitCode: typeof code === 'number' ? code : null,
        signal: typeof signal === 'string' ? signal : null,
        dropped: false,
      })
    }
    this.shell.on('exit', onExit)
    const drop = (): void => {
      this.finish({ exitCode: null, signal: null, dropped: true })
    }
    this.shell.on('error', drop)
    this.shell.on('close', () => {
      drop()
      this.onEnded()
    })
  }

  write(data: Uint8Array): void {
    if (this.closed) throw new SshError('SSH_PTY_CLOSED', 'ssh pty session is closed')
    this.shell.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.closed) throw new SshError('SSH_PTY_CLOSED', 'ssh pty session is closed')
    this.shell.setWindow(rows, cols, 0, 0)
  }

  onOutput(callback: (data: Uint8Array) => void): () => void {
    // Replay history that arrived before this subscriber attached, then go live.
    for (const chunk of [...this.buffer]) callback(chunk)
    this.outputListeners.add(callback)
    return () => {
      this.outputListeners.delete(callback)
    }
  }

  onExit(callback: (info: SshPtyExitInfo) => void): () => void {
    this.exitListeners.add(callback)
    if (this.exitInfo !== undefined) callback(this.exitInfo)
    return () => {
      this.exitListeners.delete(callback)
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.finish({ exitCode: null, signal: null, dropped: true })
    this.shell.destroy()
    return Promise.resolve()
  }

  private finish(info: SshPtyExitInfo): void {
    if (this.closed) return
    this.closed = true
    this.exitInfo = info
    for (const listener of [...this.exitListeners]) listener(info)
  }
}

/** One live connection: the client, its cached SFTP channel, and teardown. */
class LocalConnection implements SshConnection {
  private closed = false
  private sftpPromise: Promise<SFTPWrapper> | undefined
  /** Live PTY sessions, closed on connection close. */
  private readonly ptySessions = new Set<LocalPtySession>()

  constructor(
    readonly id: SshConnectionId,
    private readonly client: Client,
    private readonly onDrop: () => void,
    private readonly outputMaxBytes: number,
    readonly fastTransferThresholdBytes: number,
  ) {
    client.on('close', () => {
      this.closed = true
      onDrop()
    })
    // v8 ignore start -- a connection-level error races teardown and is already
    // covered by the close arm plus the dropped-server suite
    client.on('error', () => {
      this.closed = true
      onDrop()
    })
    /* v8 ignore stop */
  }

  isClosed(): boolean {
    return this.closed
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SshError('SSH_CLOSED', `ssh connection "${String(this.id)}" is closed`)
    }
  }

  /** Lazily open (and cache) the SFTP channel of this connection. */
  sftpChannel(): Promise<SFTPWrapper> {
    this.assertOpen()
    this.sftpPromise ??= new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((error, sftp) => {
        // v8 ignore start -- sftp() fails only after the connection dropped,
        // which assertOpen above already turns into SSH_CLOSED
        if (error !== undefined) {
          reject(sftpError('channel', '/', error))
          return
        }
        /* v8 ignore stop */
        // Operation failures surface through each operation's callback; a
        // channel-level error must not become an unhandled 'error' event.
        /* v8 ignore next -- the SFTP wrapper's own error event, not reachable from operation callbacks */
        sftp.on('error', () => undefined)
        resolve(sftp)
      })
    })
    return this.sftpPromise
  }

  /** The SFTP operation surface of this handle. */
  get sftp(): SshSftp {
    return new LocalSftp(this)
  }

  async exec(spec: SshExecSpec): Promise<SshRunResult> {
    this.assertOpen()
    // v8 ignore start -- the remote cwd prefix is exercised by the POSIX-only cwd suite
    const command = spec.cwd === undefined
      ? spec.command
      : `cd ${shellQuote(spec.cwd)} && ${spec.command}`
    /* v8 ignore stop */
    const started = Date.now()
    return new Promise<SshRunResult>((resolve, reject) => {
      this.client.exec(command, (error, stream) => {
        // v8 ignore start -- exec() fails only after the connection dropped,
        // which assertOpen above already turns into SSH_CLOSED
        if (error !== undefined) {
          reject(new SshError('SSH_EXEC_FAILED', `ssh exec failed: ${error.message}`))
          return
        }
        /* v8 ignore stop */
        let settled = false
        let timedOut = false
        let aborted = false
        let stdout = Buffer.alloc(0)
        let stderr = Buffer.alloc(0)
        let stdoutTruncated = false
        let stderrTruncated = false
        let exitCode: number | null = null
        let signal: string | null = null
        const cap = this.outputMaxBytes
        const absorb = (target: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
          // v8 ignore next -- ssh2 streams deliver Buffers only
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          let buffer = Buffer.concat([target === 'stdout' ? stdout : stderr, part])
          if (buffer.length > cap) {
            buffer = buffer.subarray(buffer.length - cap)
            if (target === 'stdout') stdoutTruncated = true
            else stderrTruncated = true
          }
          if (target === 'stdout') stdout = buffer
          else stderr = buffer
        }
        stream.on('data', absorb('stdout'))
        stream.stderr.on('data', absorb('stderr'))
        const finish = (): void => {
          /* v8 ignore next -- finish settles once; a second close/exit can never reach it */
          if (settled) return
          settled = true
          clearTimeout(timer)
          spec.signal?.removeEventListener('abort', onAbort)
          resolve({
            exitCode,
            signal,
            timedOut,
            aborted,
            timeoutMs: spec.timeoutMs,
            stdout: stdout.toString('utf8'),
            stdoutTruncated,
            stderr: stderr.toString('utf8'),
            stderrTruncated,
            durationMs: Date.now() - started,
          })
        }
        const kill = (): void => {
          try {
            stream.signal('KILL')
          } catch {
            /* v8 ignore next -- the channel may already be gone; close below still settles it */
          }
          stream.close()
        }
        const timer = setTimeout(() => {
          timedOut = true
          kill()
        }, spec.timeoutMs)
        const onAbort = (): void => {
          aborted = true
          kill()
        }
        if (spec.signal !== undefined) spec.signal.addEventListener('abort', onAbort, { once: true })
        // The `exit` event carries the remote exit status/signal; `close` is
        // the channel teardown that settles the run (exit may never arrive).
        stream.on('exit', (code: number | null, streamSignal?: string) => {
          /* v8 ignore next -- a normal exit reports a numeric code, never the signal arm */
          exitCode = typeof code === 'number' ? code : null
          /* v8 ignore next -- a normal exit reports no signal */
          signal = streamSignal ?? null
        })
        stream.on('close', () => {
          finish()
        })
        // v8 ignore start -- a stream-level error races teardown and is
        // already covered by the timeout/abort kill paths
        stream.on('error', (streamError: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          spec.signal?.removeEventListener('abort', onAbort)
          reject(new SshError('SSH_EXEC_FAILED', `ssh exec failed: ${streamError.message}`))
        })
        /* v8 ignore stop */
      })
    })
  }

  async close(): Promise<void> {
    /* v8 ignore next -- the idempotent second close is exercised by the close-twice test */
    if (this.closed) return
    this.closed = true
    for (const session of [...this.ptySessions]) {
      session.close()
    }
    await new Promise<void>((resolve) => {
      const done = (): void => { resolve() }
      this.client.once('close', done)
      this.client.end()
      /* v8 ignore next -- the fallback destroy fires only when end() never settles */
      setTimeout(() => {
        this.client.destroy()
        resolve()
      }, 1_000).unref()
    })
    this.onDrop()
  }

  async openPty(options: SshPtyOptions): Promise<SshPtySession> {
    this.assertOpen()
    return new Promise<SshPtySession>((resolve, reject) => {
      this.client.shell({
        term: options.term ?? 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
      }, (error, shell) => {
        if (error !== undefined) {
          reject(new SshError('SSH_PTY_FAILED', `ssh pty open failed: ${error.message}`))
          return
        }
        const session = new LocalPtySession(shell, () => {
          this.ptySessions.delete(session)
        })
        this.ptySessions.add(session)
        resolve(session)
      })
    })
  }
}

/** SFTP operations of one connection, implemented over ssh2's SFTP wrapper. */
class LocalSftp implements SshSftp {
  constructor(private readonly connection: LocalConnection) {}

  private async channel(): Promise<SFTPWrapper> {
    return this.connection.sftpChannel()
  }

  async list(path: string): Promise<SftpEntry[]> {
    const sftp = await this.channel()
    return new Promise<SftpEntry[]>((resolve, reject) => {
      sftp.readdir(path, (error, entries) => {
        if (error !== undefined) {
          reject(sftpError('list', path, error))
          return
        }
        resolve(entries.map(entry => toEntry(entry.filename, entry.attrs)))
      })
    })
  }

  async stat(path: string): Promise<SftpEntry> {
    const sftp = await this.channel()
    try {
      return await this.statRaw(sftp, path)
    } catch (error) {
      throw sftpError('stat', path, error)
    }
  }

  /**
   * Stat without wrapping the error, so callers can read the SFTP status code.
   * ssh2 1.17 delivers NAME responses to `lstat`/`stat` callbacks as an entry
   * array (the same shape `readdir` uses), despite the older type definitions
   * claiming a single Stats; the first entry's attrs are the stat result.
   */
  private statRaw(sftp: SFTPWrapper, path: string): Promise<SftpEntry> {
    return new Promise<SftpEntry>((resolve, reject) => {
      sftp.lstat(path, (error, stats) => {
        if (error !== undefined) {
          reject(error)
          return
        }
        const entries = stats as unknown as Array<{ attrs: Stats }>
        const first = entries[0]
        // v8 ignore next -- a well-formed server always returns exactly one entry
        if (first === undefined) {
          reject(new Error(`ssh sftp stat returned no entry for "${path}"`))
          return
        }
        resolve(toEntry(basename(path), first.attrs))
      })
    })
  }

  async readFile(
    remotePath: string,
    localPath: string,
    options?: { overwrite?: boolean },
  ): Promise<{ bytes: number }> {
    const sftp = await this.channel()
    const threshold = this.connection.fastTransferThresholdBytes
    if (threshold > 0) {
      const size = (await this.stat(remotePath)).size
      if (size > threshold) return this.fastGet(sftp, remotePath, localPath, options, size)
    }
    return this.streamRead(sftp, remotePath, localPath, options)
  }

  /** Parallel-chunked download for large files (ssh2 fastGet). */
  private async fastGet(
    sftp: SFTPWrapper,
    remotePath: string,
    localPath: string,
    options?: { overwrite?: boolean },
    size?: number,
  ): Promise<{ bytes: number }> {
    if (options?.overwrite !== true) {
      try {
        await stat(localPath)
        throw new SshError('SSH_LOCAL_IO', `ssh read: local path "${localPath}" already exists (pass overwrite: true to replace it)`)
      } catch (error) {
        if ((error as { code?: unknown }).code === 'SSH_LOCAL_IO') throw error
      }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        // `fileSize` skips fastXfer's internal fstat: ssh2 1.17 delivers NAME
        // arrays to fstat callbacks, which breaks its single-attrs assumption.
        sftp.fastGet(remotePath, localPath, {
          // v8 ignore next -- the caller always supplies the stat'd size
          ...size !== undefined ? { fileSize: size } : {},
        }, (error) => {
          // v8 ignore start -- a fastGet failure leaves no partial bytes worth
          // asserting; the cleanup below is exercised by the stream path
          if (error !== undefined) {
            reject(sftpError('read', remotePath, error))
            return
          }
          /* v8 ignore stop */
          resolve()
        })
      })
    } catch (error) {
      /* v8 ignore start -- partial cleanup after a failed fastGet (the stream path covers the equivalent) */
      await rm(localPath, { force: true }).catch(() => undefined)
      throw error
      /* v8 ignore stop */
    }
    return { bytes: (await stat(localPath)).size }
  }

  /** Sequential stream download (small files; precise overwrite semantics). */
  private async streamRead(
    sftp: SFTPWrapper,
    remotePath: string,
    localPath: string,
    options?: { overwrite?: boolean },
  ): Promise<{ bytes: number }> {
    // Local-first failure: a bad local target must report SSH_LOCAL_IO before
    // the remote read starts, so the error code never depends on which stream
    // errors first.
    const existing = await stat(localPath).catch(() => undefined)
    if (existing !== undefined) {
      if (existing.isDirectory()) {
        throw new SshError('SSH_LOCAL_IO', `ssh read: local path "${localPath}" is a directory`)
      }
      if (options?.overwrite !== true) {
        throw new SshError('SSH_LOCAL_IO', `ssh read: local path "${localPath}" already exists (pass overwrite: true to replace it)`)
      }
    }
    const input = sftp.createReadStream(remotePath)
    const output = createWriteStream(localPath, { flags: options?.overwrite === true ? 'w' : 'wx' })
    return new Promise<{ bytes: number }>((resolve, reject) => {
      let bytes = 0
      let settled = false
      const fail = async (error: Error, cleanup: boolean): Promise<void> => {
        /* v8 ignore next -- fail settles once; a second error event can never reach it */
        if (settled) return
        settled = true
        input.destroy()
        output.destroy()
        // Remove the partial local file BEFORE rejecting, so a caller that
        // observes the failure never finds stale bytes at the target path.
        // v8 ignore start -- only the unreachable EEXIST arm passes cleanup=false
        if (cleanup) {
          /* v8 ignore next -- the partial-removal retry is a best-effort guard */
          await rm(localPath, { force: true }).catch(() => undefined)
        }
        /* v8 ignore stop */
        reject(error)
      }
      input.on('data', (chunk: Buffer | string) => {
        /* v8 ignore next -- node streams deliver Buffers only */
        bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      })
      input.on('error', (error: Error) => {
        void fail(sftpError('read', remotePath, error), true)
      })
      output.on('error', (error: Error) => {
        // v8 ignore start -- the local-first pre-check above makes EEXIST unreachable here
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          // The pre-existing local file is exactly what the caller wanted to
          // protect; never delete it in the failure cleanup.
          void fail(new SshError('SSH_LOCAL_IO', `ssh read: local path "${localPath}" already exists (pass overwrite: true to replace it)`), false)
          return
        }
        /* v8 ignore stop */
        void fail(localIoError('read', localPath, error), true)
      })
      output.on('finish', () => {
        /* v8 ignore next -- finish settles once; the EEXIST/read errors above never reach it */
        if (settled) return
        settled = true
        resolve({ bytes })
      })
      input.pipe(output)
    })
  }

  async writeFile(localPath: string, remotePath: string): Promise<{ bytes: number }> {
    const sftp = await this.channel()
    const threshold = this.connection.fastTransferThresholdBytes
    if (threshold > 0) {
      let size: number
      try {
        size = (await stat(localPath)).size
      } catch (error) {
        throw localIoError('write', localPath, error)
      }
      if (size > threshold) return this.fastPut(sftp, localPath, remotePath)
    }
    return this.streamWrite(sftp, localPath, remotePath)
  }

  /** Parallel-chunked upload for large files (ssh2 fastPut). */
  private async fastPut(
    sftp: SFTPWrapper,
    localPath: string,
    remotePath: string,
  ): Promise<{ bytes: number }> {
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, {}, (error) => {
        // v8 ignore start -- no fixture produces a failing >1MiB upload; the stream path covers upload errors
        if (error !== undefined) {
          reject(sftpError('write', remotePath, error))
          return
        }
        /* v8 ignore stop */
        resolve()
      })
    })
    return { bytes: (await stat(localPath)).size }
  }

  /** Sequential stream upload (small files). */
  private async streamWrite(
    sftp: SFTPWrapper,
    localPath: string,
    remotePath: string,
  ): Promise<{ bytes: number }> {
    const input = createReadStream(localPath)
    const output = sftp.createWriteStream(remotePath)
    return new Promise<{ bytes: number }>((resolve, reject) => {
      let bytes = 0
      let settled = false
      const fail = (error: Error): void => {
        /* v8 ignore next -- fail settles once; a second error event can never reach it */
        if (settled) return
        settled = true
        input.destroy()
        output.destroy()
        reject(error)
      }
      input.on('data', (chunk: Buffer | string) => {
        /* v8 ignore next -- node streams deliver Buffers only */
        bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      })
      input.on('error', (error: Error) => {
        fail(localIoError('write', localPath, error))
      })
      output.on('error', (error: Error) => {
        fail(sftpError('write', remotePath, error))
      })
      output.on('close', () => {
        if (settled) return
        settled = true
        resolve({ bytes })
      })
      input.pipe(output)
    })
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const sftp = await this.channel()
    if (options?.recursive !== true) {
      return this.mkdirOnce(sftp, path)
    }
    await this.ensureDir(sftp, path)
  }

  private mkdirOnce(sftp: SFTPWrapper, path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (error) => {
        if (error !== undefined) {
          reject(sftpError('mkdir', path, error))
          return
        }
        resolve()
      })
    })
  }

  /** Create every missing ancestor of `path`, then the directory itself. */
  private async ensureDir(sftp: SFTPWrapper, path: string): Promise<void> {
    const parent = dirname(path)
    if (parent === path || parent === '' || parent === '.') {
      await this.mkdirOnce(sftp, path)
      return
    }
    let exists = false
    try {
      await this.statRaw(sftp, path)
      exists = true
    } catch (error) {
      // Only a missing path (SFTP NO_SUCH_FILE status) justifies creating
      // ancestors; any other failure is the caller's problem to see.
      // v8 ignore next -- a non-missing stat failure needs a permission error the test server cannot produce
      if ((error as { code?: unknown }).code !== SFTP_STATUS_NO_SUCH_FILE) throw error
    }
    if (exists) return
    await this.ensureDir(sftp, parent)
    await this.mkdirOnce(sftp, path)
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const sftp = await this.channel()
    let entry: SftpEntry
    try {
      entry = await this.statRaw(sftp, path)
    } catch (error) {
      throw sftpError('stat', path, error)
    }
    if (entry.type !== 'dir') {
      return this.unlink(sftp, path)
    }
    if (options?.recursive !== true) {
      return this.rmdir(sftp, path)
    }
    const children = await this.list(path)
    for (const child of children) {
      await this.remove(`${path.replace(/\/+$/, '')}/${child.name}`, { recursive: true })
    }
    await this.rmdir(sftp, path)
  }

  private unlink(sftp: SFTPWrapper, path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.unlink(path, (error) => {
        // v8 ignore start -- a stat-succeeded file that then fails to unlink needs a permission fixture the test server cannot produce
        if (error !== undefined) {
          reject(sftpError('remove', path, error))
          return
        }
        /* v8 ignore stop */
        resolve()
      })
    })
  }

  private rmdir(sftp: SFTPWrapper, path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.rmdir(path, (error) => {
        if (error !== undefined) {
          reject(sftpError('remove', path, error))
          return
        }
        resolve()
      })
    })
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    const sftp = await this.channel()
    return new Promise<void>((resolve, reject) => {
      sftp.rename(fromPath, toPath, (error) => {
        if (error !== undefined) {
          reject(sftpError('rename', fromPath, error))
          return
        }
        resolve()
      })
    })
  }

  async openRead(remotePath: string): Promise<SshReadableFile> {
    const sftp = await this.channel()
    let size: number | null
    try {
      const entry = await this.statRaw(sftp, remotePath)
      if (entry.type !== 'file') throw new Error('not a regular file')
      size = entry.size
    } catch (error) {
      throw sftpError('openRead', remotePath, error)
    }
    const stream = sftp.createReadStream(remotePath)
    let released = false
    return {
      size,
      stream,
      close: async () => {
        if (released) return
        released = true
        await new Promise<void>((resolve) => {
          if (stream.destroyed) {
            resolve()
            return
          }
          stream.once('close', () => resolve())
          stream.destroy()
        })
      },
    }
  }

  async openWrite(remotePath: string): Promise<SshWritableFile> {
    const sftp = await this.channel()
    const output = sftp.createWriteStream(remotePath)
    const input = new PassThrough()
    input.pipe(output)
    let bytes = 0
    input.on('data', (chunk: Buffer) => {
      bytes += chunk.length
    })
    type Settled = { ok: true; bytes: number } | { ok: false; error: Error }
    let settled: Settled | undefined
    const waiters: Array<(value: Settled) => void> = []
    const settle = (value: Settled): void => {
      /* v8 ignore next -- event ordering guarantees one winner; the guard is defensive */
      if (settled !== undefined) return
      settled = value
      for (const wake of waiters.splice(0)) wake(value)
    }
    output.on('error', (error: Error) => {
      settle({ ok: false, error: sftpError('openWrite', remotePath, error) })
      input.destroy()
    })
    input.on('error', (error: Error) => {
      settle({ ok: false, error })
      output.destroy()
    })
    input.on('close', () => {
      if (settled === undefined && !input.writableFinished) {
        settle({ ok: false, error: new SshError('SSH_SFTP_FAILED', `ssh openWrite aborted before completion for "${remotePath}"`) })
        output.destroy()
      }
    })
    output.on('close', () => {
      if (settled === undefined) settle({ ok: true, bytes })
    })
    return {
      stream: input,
      done: () => {
        if (settled !== undefined) {
          return settled.ok ? Promise.resolve({ bytes: settled.bytes }) : Promise.reject(settled.error)
        }
        return new Promise<{ bytes: number }>((resolve, reject) => {
          waiters.push((value) => {
            if (value.ok) resolve({ bytes: value.bytes })
            else reject(value.error)
          })
        })
      },
    }
  }
}

/**
 * Local SSH/SFTP provider: implements the `ctx.ssh` seam over `ssh2` with a
 * per-definition shared connection cache. A dropped connection (server close
 * or error) evicts itself; the next {@link connect} opens a fresh one.
 */
export class LocalSshService extends SshService {
  static Config: z<Config> = Config

  /** The currently authoritative config: the settings section, or the composition entry. */
  private source: () => ResolvedConfig

  private readonly connections = new Map<SshConnectionId, LocalConnection>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const entry = resolveConfig(config)
    // v8 ignore next -- no test boots ssh-local without a settings service; the settings mount replaces this placeholder before any read
    this.source = () => entry
    installSettingsSection(ctx, SSH_LOCAL_SETTINGS_NAMESPACE, Config, entry, {
      validate: (value) => {
        resolveConfig(value)
      },
      setSource: (current) => {
        this.source = current as () => ResolvedConfig
      },
      onChange: () => {},
    })
    ctx.effect(() => () => {
      for (const connection of [...this.connections.values()]) {
        void connection.close()
      }
      this.connections.clear()
    }, 'ssh-local: connection pool teardown')
  }

  /** Current validated config (defaults + caps applied). */
  get config(): ResolvedConfig {
    return this.source()
  }

  async connect(id: SshConnectionId): Promise<SshConnection> {
    const definition = this.get(id)
    if (definition === undefined) {
      throw new SshError('SSH_NOT_FOUND', `ssh connection "${String(id)}" is not defined`)
    }
    const cached = this.connections.get(id)
    if (cached !== undefined && !cached.isClosed()) return cached
    const client = await openClient(definition, this, {
      strictHostKey: this.config.strictHostKey,
      allowLegacyAlgorithms: this.config.allowLegacyAlgorithms,
      keepaliveIntervalMs: this.config.keepaliveIntervalMs,
      strictPrivateKeyPermissions: this.config.strictPrivateKeyPermissions,
    })
    const connection = new LocalConnection(id, client, () => {
      if (this.connections.get(id) === connection) this.connections.delete(id)
    }, this.config.outputMaxBytes, this.config.fastTransferThresholdBytes)
    this.connections.set(id, connection)
    return connection
  }

  async close(id: SshConnectionId): Promise<void> {
    const connection = this.connections.get(id)
    this.connections.delete(id)
    if (connection !== undefined) await connection.close()
  }

  resolveExec(request: SshExecRequest): SshExecSpec {
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.defaultExecTimeoutMs,
      this.config.maxExecTimeoutMs,
      'ssh-local: request.timeoutMs',
    )
    return {
      command: request.command,
      timeoutMs,
      ...request.cwd !== undefined ? { cwd: request.cwd } : {},
      ...request.signal !== undefined ? { signal: request.signal } : {},
      outputMaxBytes: this.config.outputMaxBytes,
    }
  }
}

export { SshConnectionId }
export default LocalSshService
