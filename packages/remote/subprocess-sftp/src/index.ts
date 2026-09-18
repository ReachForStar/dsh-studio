/**
 * SSH exec/PTY implementation of the `ctx.subprocess` seam over the fork's
 * `ctx.sshSftp` connection. The remote host needs only OpenSSH: one-shot
 * commands run through the streaming exec primitive, terminals through a PTY
 * whose wrapper publishes its pid to a remote /tmp file. No remote Node or
 * helper binary is required.
 * @module @reachforstar/dsh-subprocess-sftp
 */

import { PassThrough, type Duplex, type Readable, type Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { SshError } from '@reachforstar/dsh-ssh'
import type { SshConnection, SshConnectionId, SshExecSession, SshPtySession } from '@reachforstar/dsh-ssh'

/** Configuration for the remote subprocess provider. */
export interface Config {
  /** Name or id of the saved `ctx.sshSftp` connection commands run on. */
  connection: string
}

/** Shell-variable name validation (env keys become shell assignments). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Build the `env` prefix of one explicit env layer (tombstones unset first). */
function envPrefix(env: Record<string, string | undefined> | undefined): string {
  if (env === undefined) return ''
  const unset: string[] = []
  const assign: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key)) throw new Error(`invalid environment variable name "${key}"`)
    if (value === undefined) unset.push(`-u ${key}`)
    else assign.push(`${key}=${shellQuote(value)}`)
  }
  if (unset.length === 0 && assign.length === 0) return ''
  // The `env` utility, not shell `unset`: unsetting PATH in the outer shell
  // breaks the command lookup of the very exec that follows.
  return `env ${[...unset, ...assign].join(' ')}`
}

interface ExitInfo {
  exitCode: number | null
  signal: string | null
  dropped: boolean
}

/** One managed remote process over a streaming exec channel. */
class RemoteProcess implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly control: Duplex | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  private readonly out = new PassThrough()
  private readonly err = new PassThrough()
  private readonly inbound = new PassThrough()
  private readonly started: Promise<SshExecSession | undefined>
  private settleResolve!: (value: SubprocessOutcome) => void
  private settleReject!: (error: Error) => void
  private readonly settled: Promise<SubprocessOutcome>
  private settledDone = false
  private closed = false
  /** Set when THIS caller began the termination (channel close is then an outcome, not a failure). */
  private terminatedByCaller = false
  private readonly collectors: Partial<Record<'stdout' | 'stderr', OutputCollector>> = {}

  constructor(
    private readonly provider: SftpSubprocessRuntime,
    private readonly spec: SubprocessSpawnSpec,
    lifetimeSignal: AbortSignal,
  ) {
    let resolve!: (value: SubprocessOutcome) => void
    let reject!: (error: Error) => void
    this.settled = new Promise<SubprocessOutcome>((res, rej) => {
      resolve = res
      reject = rej
    })
    this.settleResolve = resolve
    this.settleReject = reject
    // A control channel needs a fourth file descriptor on the remote process;
    // the SSH exec channel only carries 0/1/2, so the request fails loud.
    if ((spec.stdio as typeof spec.stdio & { control?: 'pipe' }).control === 'pipe') {
      throw new Error('the SSH subprocess provider cannot provide a control channel over one exec session')
    }
    this.control = undefined
    this.stdin = spec.stdio.stdin === 'pipe' ? this.inbound : undefined
    this.stdout = spec.stdio.stdout === 'pipe' ? this.out : undefined
    this.stderr = spec.stdio.stderr === 'pipe' ? this.err : undefined
    for (const stream of [this.inbound, this.out, this.err]) stream.on('error', () => {})
    const stdoutReader = this.buildCollector('stdout', spec.stdio.stdout)
    const stderrReader = this.buildCollector('stderr', spec.stdio.stderr)
    this.collected = {
      ...stdoutReader === undefined ? {} : { stdout: stdoutReader },
      ...stderrReader === undefined ? {} : { stderr: stderrReader },
    }
    this.spec.signal?.addEventListener('abort', () => {
      this.terminate()
    }, { once: true })
    this.started = this.provider.connection().then(async (connection) => {
      const session = await connection.openExec({
        command: this.buildCommand(),
        signal: this.spec.signal === undefined ? lifetimeSignal : AbortSignal.any([this.spec.signal, lifetimeSignal]),
      })
      session.onStdout((chunk) => {
        this.deliver('stdout', Buffer.from(chunk))
      })
      session.onStderr((chunk) => {
        this.deliver('stderr', Buffer.from(chunk))
      })
      this.wireStdin(session)
      session.onExit((info) => {
        this.closed = true
        this.finish(info)
      })
      return session
    }, (error: unknown) => {
      // A connection that cannot be established must reject done, not hang it.
      this.settledDone = true
      this.settleReject(error instanceof Error ? error : new Error(String(error)))
      return undefined
    })
    void this.started.catch((error: unknown) => {
      // openExec can reject too (e.g. the caller aborted before the channel
      // opened); settle done either way so the handle never hangs.
      if (this.settledDone) return
      this.settledDone = true
      if (this.terminatedByCaller) {
        this.settleResolve({ exitCode: null, signal: null })
        return
      }
      this.settleReject(error instanceof Error ? error : new Error(String(error)))
    })
    this.done = this.settled
    void this.done.catch(() => {})
  }

  private buildCommand(): string {
    const cd = `cd ${shellQuote(this.spec.cwd)} 2>/dev/null || exit 126`
    const pre = envPrefix(this.spec.env)
    const argv = this.spec.argv.map(shellQuote).join(' ')
    // `env` executes the command itself; without an env layer, `exec`
    // replaces the shell so the command IS the session process.
    return `${cd}; ${pre === '' ? `exec ${argv}` : `${pre} ${argv}`}`
  }

  private buildCollector(name: 'stdout' | 'stderr', mode: SubprocessOutputMode): SubprocessCollectedOutputs['stdout'] | undefined {
    if (typeof mode !== 'object') return undefined
    const collector = new OutputCollector(mode.maxBytes, mode.spill?.maxBytes, name, this.provider.spillDir)
    this.collectors[name] = collector
    return { readFrom: (fromByte: number) => collector.readFrom(fromByte) }
  }

  private deliver(name: 'stdout' | 'stderr', buffer: Buffer): void {
    const mode = this.spec.stdio[name]
    if (mode === 'pipe') {
      if (name === 'stdout') this.out.write(buffer)
      else this.err.write(buffer)
      return
    }
    if (mode === 'inherit') {
      if (name === 'stdout') process.stdout.write(buffer)
      else process.stderr.write(buffer)
      return
    }
    this.collectors[name]?.push(buffer)
  }

  private wireStdin(session: SshExecSession): void {
    const mode = this.spec.stdio.stdin
    if (mode === 'pipe') {
      this.inbound.on('data', (chunk: Buffer) => {
        try {
          session.write(chunk)
        } catch {
          /* the session closed; done surfaces the outcome */
        }
      })
      this.inbound.on('end', () => {
        try {
          session.endStdin()
        } catch {
          /* already closed */
        }
      })
      return
    }
    try {
      if (typeof mode === 'object') session.write(Buffer.from(mode.data, 'utf8'))
      session.endStdin()
    } catch {
      /* already closed */
    }
  }

  /** The channel close is the definitive remote outcome; settle once. */
  private finish(info: ExitInfo): void {
    if (this.settledDone) return
    this.settledDone = true
    if (info.dropped) {
      this.out.destroy(new Error('the remote exec session was dropped'))
      this.err.destroy(new Error('the remote exec session was dropped'))
      if (this.terminatedByCaller) {
        // Caller-initiated close kills the remote command without a remote exit
        // status; that is a quiet outcome, not a transport failure.
        this.settleResolve({ exitCode: null, signal: null })
        return
      }
      this.settleReject(new Error('the remote exec session was dropped before it exited'))
      return
    }
    this.out.end()
    this.err.end()
    for (const collector of Object.values(this.collectors)) collector.seal()
    this.settleResolve({
      exitCode: info.exitCode,
      signal: (info.signal as NodeJS.Signals | null) ?? null,
    })
  }

  terminate(): void {
    if (this.closed) return
    this.closed = true
    this.terminatedByCaller = true
    // The session may not exist yet (connection still in flight); a terminate
    // before the channel opens must still be honored once it does.
    void this.started.then((session) => {
      if (session !== undefined) void session.close().catch(() => undefined)
    }).catch(() => undefined)
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    const session = await this.started
    if (session === undefined) return true
    if (session.closed) return true
    if (signal?.aborted) return false
    const finished = new Promise<boolean>((resolve) => {
      session.onExit(() => {
        resolve(true)
      })
    })
    if (signal === undefined) return finished
    const cancelled = new Promise<boolean>((resolve) => {
      const abort = (): void => {
        resolve(false)
      }
      signal.addEventListener('abort', abort, { once: true })
      void finished.then(() => {
        signal.removeEventListener('abort', abort)
      })
    })
    return await Promise.race([finished, cancelled])
  }
}

/**
 * The remote SSH subprocess provider. Registers as `ctx.subprocess` (loading
 * it INSTEAD of `dsh-subprocess-local` is the whole swap). One shared
 * `ctx.sshSftp` connection serves every process; the provider never closes it
 * (other consumers may hold it).
 */
export class SftpSubprocessRuntime extends SubprocessRuntime {
  static Config: z<Config> = z.object({
    connection: z.string(),
  })

  static inject = ['sshSftp']

  /** POSIX signal numbers of the seam's five terminal signals. */
  private static readonly REMOTE_SIGNAL_NUMBERS: Record<SubprocessTerminalSignal, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGKILL: 9,
    SIGTERM: 15,
    SIGTSTP: 20,
  }

  private readonly connectionId: SshConnectionId
  private connectionPromise: Promise<SshConnection> | undefined
  /** Local spill directory for collected-stream spill files. */
  readonly spillDir: string
  private readonly live = new Set<RemoteProcess>()
  private readonly terminals = new Set<SubprocessTerminalHandle>()
  private readonly terminalAllocations = new Set<Promise<SubprocessTerminalHandle>>()
  private readonly lifetime = new AbortController()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.connectionId = ctx.sshSftp.resolve(config.connection).id
    this.spillDir = process.env.TMPDIR ?? (process.platform === 'win32' ? process.env.TEMP ?? '' : '/tmp')
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('the SSH subprocess provider was disposed'))
      const processes = [...this.live].map(handle => (async () => {
        handle.terminate()
        try {
          await handle.waitForExit()
        } catch {
          /* a dropped session still counts as quiet */
        }
      })())
      const terminalClosures = [...this.terminals].map(handle => handle.terminate().catch(() => undefined))
      await Promise.allSettled([...processes, ...terminalClosures])
      await Promise.allSettled([...this.terminalAllocations])
    }, 'subprocess-sftp: process teardown')
  }

  /**
   * The shared connection for this provider's configured definition (lazy).
   * @returns the live connection handle for the configured definition.
   */
  connection(): Promise<SshConnection> {
    this.connectionPromise ??= this.ctx.sshSftp.connect(this.connectionId)
    return this.connectionPromise
  }

  private async exec(command: string, signal?: AbortSignal): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const connection = await this.connection()
    const spec = this.ctx.sshSftp.resolveExec({ command, ...(signal === undefined ? {} : { signal }) })
    try {
      const result = await connection.exec(spec)
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    } catch (error: unknown) {
      if (error instanceof SshError) throw error
      throw new Error(`remote exec failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  override async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    if (command.startsWith('/')) {
      const result = await this.exec(`[ -x ${shellQuote(command)} ] && printf %s ${shellQuote(command)}`, signal)
      if (result.exitCode === 0 && result.stdout === command) return command
      throw new SubprocessExecutableNotFoundError(`executable "${command}" was not found on the remote host`)
    }
    if (command.includes('/')) {
      throw new SubprocessExecutableNotFoundError(`relative executable path "${command}" cannot be resolved; use an absolute path or a bare PATH name`)
    }
    const pathPrefix = env?.PATH !== undefined && env.PATH !== '' ? `PATH=${shellQuote(env.PATH)}` : ''
    const result = await this.exec(`${pathPrefix === '' ? '' : `${pathPrefix} `}command -v ${shellQuote(command)}`, signal)
    const found = result.stdout.trim()
    if (result.exitCode === 0 && found.length > 0) return found
    throw new SubprocessExecutableNotFoundError(`executable "${command}" was not found on the remote host`)
  }

  override async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    const result = await this.exec('S=$SHELL; [ -n "$S" ] && printf %s "$S"', signal)
    const shell = result.stdout.trim()
    return {
      platform: 'posix',
      ...shell.length > 0 ? { defaultShell: shell } : {},
    }
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.lifetime.signal.throwIfAborted()
    spec.signal?.throwIfAborted()
    if (spec.argv.length === 0) throw new Error('spawn requires at least one argv entry')
    const handle = new RemoteProcess(this, spec, this.lifetime.signal)
    this.live.add(handle)
    void handle.done.then(() => handle.waitForExit()).catch(() => undefined).finally(() => {
      this.live.delete(handle)
    })
    return handle
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    this.lifetime.signal.throwIfAborted()
    const signal = spec.signal === undefined ? this.lifetime.signal : AbortSignal.any([spec.signal, this.lifetime.signal])
    signal.throwIfAborted()
    const allocation = this.createTerminal(spec, signal)
    this.terminalAllocations.add(allocation)
    try {
      return await allocation
    } finally {
      this.terminalAllocations.delete(allocation)
    }
  }

  /**
   * Allocate one remote PTY. The wrapper prints its pid (the shell `exec`s
   * over the wrapper, so the printed pid IS the shell's) as a token-stamped
   * first output line, which the provider reads from the session output — no
   * remote /tmp dependency.
   */
  private async createTerminal(spec: SubprocessTerminalSpawnSpec, signal: AbortSignal): Promise<SubprocessTerminalHandle> {
    const connection = await this.connection()
    const token = randomUUID()
    const marker = `__DSH_SFTP_PTY__${token}`
    const envPrefix = spec.env === undefined ? '' : Object.entries(spec.env)
      .map(([key, value]) => {
        if (!ENV_NAME.test(key)) throw new Error(`invalid environment variable name "${key}"`)
        return `${key}=${shellQuote(value)}`
      }).join(' ')
    const command = [
      `cd ${shellQuote(spec.cwd)} 2>/dev/null`,
      `printf '%s %s\\n' ${shellQuote(marker)} "$$"`,
      `exec ${envPrefix === '' ? '' : `${envPrefix} `}${spec.argv.map(shellQuote).join(' ')}`,
    ].join('; ')
    let session: SshPtySession | undefined
    try {
      session = await connection.openPty({
        cols: spec.cols,
        rows: spec.rows,
        term: spec.terminalType,
        command,
      })
      signal.throwIfAborted()
      const pid = await this.readPidFromOutput(session, marker, signal)
      return this.buildTerminalHandle(session, pid)
    } catch (error: unknown) {
      if (session !== undefined) {
        await session.close().catch(() => undefined)
      }
      throw error
    }
  }

  /** Wait for the wrapper's token-stamped pid line on the PTY output. */
  private readPidFromOutput(session: SshPtySession, marker: string, signal: AbortSignal): Promise<number> {
    // The marker is a unique token, so an unanchored search over the buffered
    // text is safe (line boundaries may split across chunks).
    const pattern = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} (\\d+)`, 'u')
    return new Promise<number>((resolve, reject) => {
      let text = ''
      let settled = false
      // The onOutput subscription replays buffered chunks synchronously, so the
      // unsubscribe handle must exist (as a no-op at least) before it is attached.
      let unsubscribe: () => void = (): void => {
        // Replaced by the real subscription immediately below.
      }
      const settle = (settleWith: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe()
        settleWith()
      }
      const timer = setTimeout(() => {
        settle(() => {
          reject(new Error('the remote PTY wrapper did not publish its pid within 5s'))
        })
      }, 5_000)
      timer.unref()
      unsubscribe = session.onOutput((chunk) => {
        if (text.length > 8192) return
        text += Buffer.from(chunk).toString('utf8')
        const pidText = pattern.exec(text)?.[1]
        if (pidText !== undefined) {
          settle(() => {
            resolve(Number.parseInt(pidText, 10))
          })
        }
      })
      session.onExit(() => {
        settle(() => {
          reject(new Error('the remote PTY session terminated before the wrapper published its pid'))
        })
      })
      signal.addEventListener('abort', () => {
        settle(() => {
          reject(new Error('terminal allocation aborted before the wrapper published its pid'))
        })
      }, { once: true })
    })
  }

  /**
   * The remote foreground-group probe. On Linux it scans the group for a
   * sleeping process holding the session pty on stdin: exact when /proc/<pid>/syscall
   * is readable (blocked on read(0)), degraded to that weaker fact under a
   * restricted ptrace scope where the syscall file is unreadable.
   */
  private readonly foregroundProbe = (pid: number) => `pid=${String(pid)}; if [ -r "/proc/$pid/stat" ]; then tty=$(readlink "/proc/$pid/fd/0" 2>/dev/null); st=$(cat "/proc/$pid/stat" 2>/dev/null) || exit 0; x=\${st#*) }; set -- $x; pgrp=\$3; [ -n "$pgrp" ] || exit 0; waiting=0; for p in /proc/[0-9]*; do case \${p#/proc/} in ''|*[!0-9]*) continue;; esac; qst=$(cat "$p/stat" 2>/dev/null) || continue; qx=\${qst#*) }; set -- $qx; [ "\$3" = "$pgrp" ] || continue; [ "\$1" = S ] || continue; f0=$(readlink "$p/fd/0" 2>/dev/null) || continue; [ -n "$tty" ] || continue; [ "$f0" = "$tty" ] || continue; sc=$(cat "$p/syscall" 2>/dev/null); case $sc in '0 0x0 '*) waiting=1; break;; '') waiting=1; break;; esac; done; printf 'tpgid=%s waiting=%s\\n' "$pgrp" "$waiting"; else tpgid=$(ps -o tpgid= -p "$pid" 2>/dev/null | tr -d ' \\r\\n'); [ -z "$tpgid" ] && exit 0; printf 'tpgid=%s waiting=0\\n' "$tpgid"; fi`

  private buildTerminalHandle(
    session: SshPtySession,
    pid: number,
  ): SubprocessTerminalHandle {
    const output = new PassThrough()
    output.on('error', () => {})
    let outputEnded = false
    session.onOutput((chunk) => {
      if (!outputEnded) output.write(Buffer.from(chunk))
    })
    let closing: Promise<void> | undefined
    let callerTerminated = false
    const done = new Promise<SubprocessOutcome>((resolve, reject) => {
      session.onExit((info) => {
        if (outputEnded) return
        outputEnded = true
        output.end()
        if (info.dropped) {
          if (callerTerminated) {
            // Caller-initiated close ends the session without a remote exit status.
            resolve({ exitCode: null, signal: null })
            return
          }
          reject(new Error('the remote PTY session was dropped before the shell exited'))
          return
        }
        resolve({ exitCode: info.exitCode, signal: (info.signal as NodeJS.Signals | null) ?? null })
      })
    })
    void done.catch(() => {})
    const handle: SubprocessTerminalHandle = {
      pid,
      output,
      done,
      // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
      write: async (data: string) => {
        session.write(Buffer.from(data, 'utf8'))
      },
      // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
      resize: async (cols: number, rows: number) => {
        session.resize(cols, rows)
      },
      inspectForeground: async () => {
        const result = await this.exec(this.foregroundProbe(pid))
        const processGroupIdText = /^tpgid=(\d+)/u.exec(result.stdout)?.[1]
        if (processGroupIdText === undefined) return undefined
        const processGroupId = Number.parseInt(processGroupIdText, 10)
        const waitingMatch = /waiting=(\d+)/u.exec(result.stdout)
        return { processGroupId, inputWaiting: waitingMatch?.[1] === '1' }
      },
      signalForeground: async (signalName: SubprocessTerminalSignal) => {
        const foreground = await handle.inspectForeground()
        if (foreground === undefined) throw new Error('no foreground process group can be resolved on the remote terminal')
        // Numeric signals: the remote shell is whatever the user runs (dash's
        // kill rejects `-SIGINT`); the five seam signals are POSIX-stable.
        const number = SftpSubprocessRuntime.REMOTE_SIGNAL_NUMBERS[signalName]
        const result = await this.exec(`kill -${String(number)} -${String(foreground.processGroupId)}`)
        if (result.exitCode !== 0) throw new Error(`signalling remote process group ${String(foreground.processGroupId)} failed: ${result.stderr}`)
        return foreground.processGroupId
      },
      terminate: async () => {
        closing ??= (async () => {
          callerTerminated = true
          await session.close().catch(() => undefined)
          if (!outputEnded) {
            outputEnded = true
            output.end()
          }
          this.terminals.delete(handle)
        })()
        return closing
      },
    }
    this.terminals.add(handle)
    return handle
  }
}

export default SftpSubprocessRuntime
