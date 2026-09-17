/**
 * Minimal real subclass of the `ctx.sshSftp` Service Definition for tests: the
 * registry under test is the base class itself, so the stub implements only
 * the abstract connection contract and records its calls.
 */

import { SshConnectionId, SshError, SshService } from '../src/index.ts'
import type {
  SshConnection,
  SshExecRequest,
  SshExecSpec,
  SshPtyExitInfo,
  SshPtySession,
  SshRunResult,
  SshSftp,
} from '../src/index.ts'

/**
 * One scripted terminal the stub handed out. Termination is reported exactly
 * once and replayed to a subscriber that arrives after it, which is the
 * contract the real provider's session keeps.
 */
export class StubSshPtySession implements SshPtySession {
  /** True once the session terminated. */
  closed = false
  /** Bytes written to the session, in order. */
  readonly written: Uint8Array[] = []
  private readonly exits = new Set<(info: SshPtyExitInfo) => void>()
  private terminated: SshPtyExitInfo | undefined

  write(data: Uint8Array): void {
    this.written.push(data)
  }

  resize(): void {
    // No window to resize in a stub.
  }

  onOutput(): () => void {
    return () => undefined
  }

  onExit(callback: (info: SshPtyExitInfo) => void): () => void {
    if (this.terminated !== undefined) {
      callback(this.terminated)
      return () => undefined
    }
    this.exits.add(callback)
    return () => {
      this.exits.delete(callback)
    }
  }

  /** Report the shell's termination to every subscriber, once. */
  exit(info: SshPtyExitInfo = { exitCode: 0, signal: null, dropped: false }): void {
    if (this.terminated !== undefined) return
    this.terminated = info
    this.closed = true
    const subscribers = [...this.exits]
    this.exits.clear()
    for (const callback of subscribers) callback(info)
  }

  close(): Promise<void> {
    this.exit({ exitCode: null, signal: null, dropped: true })
    return Promise.resolve()
  }
}

export class StubSshService extends SshService {
  /** Probe outcome the next connect reports. */
  connectResult: Pick<SshRunResult, 'exitCode' | 'timedOut' | 'aborted'> = { exitCode: 0, timedOut: false, aborted: false }
  /** When set, connect throws this value instead of returning a handle. */
  connectError: unknown = undefined
  /** When set, the next connection close throws this value instead of closing. */
  closeError: unknown = undefined
  /** Recorded resolveExec requests (order preserved). */
  readonly resolved: SshExecRequest[] = []
  /** The last handle connect produced; close() clears it. */
  connected: SshConnection | undefined
  /** Definition ids connect opened, in order (a cache hit is not an open). */
  readonly opened: string[] = []
  /** Definition ids a handle closed, in order. */
  readonly closed: string[] = []
  /** Terminals the stub handed out, in order. */
  readonly ptys: StubSshPtySession[] = []
  /** SFTP directory listings the stub served, in order. */
  readonly listed: string[] = []

  /** Live handles by definition id: the stub shares them like the real provider does. */
  private readonly handles = new Map<string, SshConnection>()

  async connect(id: SshConnectionId): Promise<SshConnection> {
    const definition = this.get(id)
    if (definition === undefined) throw new SshError('SSH_NOT_FOUND', `ssh connection "${String(id)}" is not defined`)
    if (this.connectError !== undefined) throw this.connectError
    const cached = this.handles.get(String(id))
    if (cached !== undefined) return cached
    const result = this.connectResult
    const connection: SshConnection = {
      id,
      exec: async _spec => ({
        exitCode: result.exitCode,
        signal: null,
        timedOut: result.timedOut,
        aborted: result.aborted,
        timeoutMs: 0,
        stdout: 'ok',
        stdoutTruncated: false,
        stderr: '',
        stderrTruncated: false,
        durationMs: 1,
      }),
      openPty: async () => {
        const session = new StubSshPtySession()
        this.ptys.push(session)
        return session
      },
      sftp: {
        list: async (path) => {
          this.listed.push(path)
          return [{
            name: 'entry.txt', path: `${path === '/' ? '' : path}/entry.txt`, type: 'file' as const, size: 3, mtimeMs: 1, mode: 0o644,
          }]
        },
        stat: async path => ({
          name: path.split('/').pop() ?? path, path, type: 'file' as const, size: 3, mtimeMs: 1, mode: 0o644,
        }),
        readFile: async () => ({ bytes: 0 }),
        writeFile: async () => ({ bytes: 0 }),
        mkdir: async () => undefined,
        remove: async () => undefined,
        rename: async () => undefined,
        openRead: async () => { throw new Error('the stub serves no readable files') },
        openWrite: async () => { throw new Error('the stub serves no writable files') },
      } satisfies SshSftp,
      close: async () => {
        const failure = this.closeError
        this.closeError = undefined
        if (failure !== undefined) throw failure
        this.handles.delete(String(id))
        this.closed.push(String(id))
        this.connected = undefined
      },
    }
    this.opened.push(String(id))
    this.handles.set(String(id), connection)
    this.connected = connection
    return connection
  }

  async close(): Promise<void> {
    this.handles.clear()
    this.connected = undefined
  }

  resolveExec(request: SshExecRequest): SshExecSpec {
    this.resolved.push(request)
    return { command: request.command, timeoutMs: request.timeoutMs ?? 60_000, outputMaxBytes: 65_536 }
  }
}
