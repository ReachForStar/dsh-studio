/**
 * Minimal real subclass of the `ctx.ssh` Service Definition for tests: the
 * registry under test is the base class itself, so the stub implements only
 * the abstract connection contract and records its calls.
 */

import { SshConnectionId, SshError, SshService } from '../src/index.ts'
import type { SshConnection, SshExecRequest, SshExecSpec, SshRunResult, SshSftp } from '../src/index.ts'

export class StubSshService extends SshService {
  /** Probe outcome the next connect reports. */
  connectResult: Pick<SshRunResult, 'exitCode' | 'timedOut' | 'aborted'> = { exitCode: 0, timedOut: false, aborted: false }
  /** When set, connect throws this value instead of returning a handle. */
  connectError: unknown = undefined
  /** Recorded resolveExec requests (order preserved). */
  readonly resolved: SshExecRequest[] = []
  /** The last handle connect produced; close() clears it. */
  connected: SshConnection | undefined

  async connect(id: SshConnectionId): Promise<SshConnection> {
    const definition = this.get(id)
    if (definition === undefined) throw new SshError('SSH_NOT_FOUND', `ssh connection "${String(id)}" is not defined`)
    if (this.connectError !== undefined) throw this.connectError
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
      sftp: {} as SshSftp,
      close: async () => {
        this.connected = undefined
      },
    }
    this.connected = connection
    return connection
  }

  async close(): Promise<void> {
    this.connected = undefined
  }

  resolveExec(request: SshExecRequest): SshExecSpec {
    this.resolved.push(request)
    return { command: request.command, timeoutMs: request.timeoutMs ?? 60_000, outputMaxBytes: 65_536 }
  }
}
