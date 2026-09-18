/**
 * SftpSubprocessRuntime over a REAL in-process ssh2 server: streaming exec
 * for one-shot commands (collect/pipe stdio, stdin data/pipe, exit codes,
 * caller termination) and PTY terminals (token-stamped pid discovery,
 * foreground group inspection/signalling, resize, termination). The exec
 * children run in their own process group (`detachedExec`) so foreground
 * signalling targets only the session, matching real OpenSSH.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import LocalSshService from '@reachforstar/dsh-ssh-local'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { SftpSubprocessRuntime } from '../src/index.ts'
import { TEST_SSH_PASSWORD, TEST_SSH_USERNAME, TestSshServer } from '../../ssh-local/tests/test-server.ts'

const posixSuite = process.platform === 'win32' ? describe.skip : describe

posixSuite('sftp subprocess provider', () => {
  let server: TestSshServer
  let ctx: Context
  let fiber: Awaited<ReturnType<Context['plugin']>> | undefined

  beforeEach(async () => {
    server = await TestSshServer.start({ detachedExec: true })
    await mkdir(join(server.root, 'ws'), { recursive: true })
    ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(LocalSshService, { defaultExecTimeoutMs: 60_000, maxExecTimeoutMs: 300_000, outputMaxBytes: 65_536 })
    const saved = await ctx.sshSftp.save({
      name: 'sp-box',
      host: '127.0.0.1',
      port: server.port,
      username: TEST_SSH_USERNAME,
      auth: { kind: 'password', password: TEST_SSH_PASSWORD },
      connectTimeoutMs: 5000,
    })
    fiber = await ctx.plugin(SftpSubprocessRuntime, { connection: saved.name })
  })

  afterEach(async () => {
    await fiber?.dispose()
    await server.stop()
  })

  describe('resolveExecutable', () => {
    it('accepts an existing absolute path', async () => {
      await expect(ctx.subprocess.resolveExecutable('/bin/echo')).resolves.toBe('/bin/echo')
    })

    it('rejects a missing absolute path with the typed error', async () => {
      await expect(ctx.subprocess.resolveExecutable('/definitely/missing'))
        .rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    })

    it('resolves bare names through the remote PATH', async () => {
      const found = await ctx.subprocess.resolveExecutable('sh')
      expect(found).toMatch(/^\/.+\bsh$/u)
    })

    it('honors an explicit PATH override for bare names', async () => {
      // A non-builtin name: `command -v` reports builtins by name, never by path.
      const found = await ctx.subprocess.resolveExecutable('ls', { PATH: '/usr/bin' })
      expect(found).toBe('/usr/bin/ls')
    })

    it('rejects a bare name that does not exist', async () => {
      await expect(ctx.subprocess.resolveExecutable('no-such-cmd-xyz'))
        .rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    })

    it('rejects a relative path with a separator', async () => {
      await expect(ctx.subprocess.resolveExecutable('./sh'))
        .rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    })
  })

  it('reports the terminal environment as posix with a shell', async () => {
    const env = await ctx.subprocess.terminalEnvironment()
    expect(env.platform).toBe('posix')
    expect(typeof env.defaultShell).toBe('string')
  })

  describe('spawn', () => {
    it('collects stdout and stderr separately with the exit code', async () => {
      const handle = ctx.subprocess.spawn({
        argv: ['sh', '-c', 'echo out; echo err 1>&2; exit 5'],
        cwd: '/',
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 65_536 },
          stderr: { maxBytes: 65_536 },
        },
        graceMs: 1_000,
      })
      const outcome = await handle.done
      expect(outcome.exitCode).toBe(5)
      expect(outcome.signal).toBeNull()
      expect(handle.collected.stdout?.readFrom(0).text).toBe('out\n')
      expect(handle.collected.stderr?.readFrom(0).text).toBe('err\n')
    })

    it('streams piped stdout and stderr to the caller', async () => {
      const handle = ctx.subprocess.spawn({
        argv: ['sh', '-c', 'echo piped; echo stderred 1>&2'],
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 1_000,
      })
      const out = await readStream(handle.stdout)
      const err = await readStream(handle.stderr)
      expect(out).toBe('piped\n')
      expect(err).toBe('stderred\n')
      expect(handle.collected.stdout).toBeUndefined()
    })

    it('writes batch stdin and closes it', async () => {
      const handle = ctx.subprocess.spawn({
        argv: ['sh', '-c', 'cat'],
        cwd: '/',
        stdio: {
          stdin: { data: 'hello\n' },
          stdout: { maxBytes: 65_536 },
          stderr: { maxBytes: 65_536 },
        },
        graceMs: 1_000,
      })
      await handle.done
      expect(handle.collected.stdout?.readFrom(0).text).toBe('hello\n')
    })

    it('carries piped stdin both ways', async () => {
      const handle = ctx.subprocess.spawn({
        argv: ['sh', '-c', 'cat'],
        cwd: '/',
        stdio: { stdin: 'pipe', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
        graceMs: 1_000,
      })
      expect(handle.stdin).toBeDefined()
      handle.stdin!.write('ab')
      handle.stdin!.end()
      await handle.done
      expect(handle.collected.stdout?.readFrom(0).text).toBe('ab')
    })

    it('fails with exit 126 when the remote cwd is missing', async () => {
      const handle = ctx.subprocess.spawn({
        argv: ['sh', '-c', 'echo never'],
        cwd: '/missing-dir',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
        graceMs: 1_000,
      })
      const outcome = await handle.done
      expect(outcome.exitCode).toBe(126)
    })

    it('applies the explicit env layer (set and tombstone)', async () => {
      // A non-PATH tombstone: shells restore a default PATH at startup, so
      // a tombstoned PATH is never observable inside a child shell.
      const handle = ctx.subprocess.spawn({
        argv: ['sh', '-c', 'printf %s "$MY_VAR" | tr a-z A-Z; printf %s "${HOME:+home-set}"'],
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
        graceMs: 1_000,
        env: { MY_VAR: 'set-me', HOME: undefined },
      })
      await handle.done
      expect(handle.collected.stdout?.readFrom(0).text).toBe('SET-ME')
    })

    it('terminates a running process quietly (caller close is an outcome)', async () => {
      const handle = ctx.subprocess.spawn({
        argv: ['sh', '-c', 'sleep 30'],
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
        graceMs: 5_000,
      })
      const wait = handle.done
      await new Promise(resolve => setTimeout(resolve, 300))
      handle.terminate()
      const outcome = await wait
      expect(outcome.exitCode).toBeNull()
      expect(outcome.signal).toBeNull()
      await expect(handle.waitForExit()).resolves.toBe(true)
    })

    it('starts the termination ladder on the spec abort signal', async () => {
      const abort = new AbortController()
      const handle = ctx.subprocess.spawn({
        argv: ['sh', '-c', 'sleep 30'],
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
        graceMs: 5_000,
        signal: abort.signal,
      })
      const wait = handle.done
      setTimeout(() => {
        abort.abort()
      }, 200)
      const outcome = await wait
      expect(outcome.exitCode).toBeNull()
    })

    it('throws for a requested control channel (no fourth fd over SSH)', () => {
      expect(() => ctx.subprocess.spawn({
        argv: ['sh', '-c', 'echo x'],
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', control: 'pipe' },
        graceMs: 1_000,
      })).toThrow(/control channel/)
    })

    it('throws on an empty argv', () => {
      expect(() => ctx.subprocess.spawn({
        argv: [],
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
        graceMs: 1_000,
      })).toThrow(/argv/)
    })

    it('spills collected output past the in-memory cap to a spill file', async () => {
      const handle = ctx.subprocess.spawn({
        argv: ['sh', '-c', 'yes A | head -c 200000; echo'],
        cwd: '/',
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1_000, spill: { maxBytes: 500_000 } },
          stderr: { maxBytes: 1_000 },
        },
        graceMs: 5_000,
      })
      await handle.done
      const read = handle.collected.stdout?.readFrom(0)
      expect(read).toBeDefined()
      expect(read?.lossy).toBe(true)
      expect(read?.spillPath).toBeDefined()
      if (read?.spillPath !== undefined) {
        const { readFile } = await import('node:fs/promises')
        const full = await readFile(read.spillPath, 'utf8')
        expect(full.length).toBeGreaterThanOrEqual(200_000)
      }
    })
  })

  describe('spawnTerminal', () => {
    async function spawnCatTerminal(): Promise<SubprocessTerminalHandle> {
      return await ctx.subprocess.spawnTerminal({
        argv: ['sh', '-c', 'echo term-ready; cat'],
        cwd: '/',
        rows: 24,
        cols: 80,
        terminalType: 'xterm-256color',
        graceMs: 5_000,
      })
    }

    it('allocates a terminal, discovers the pid, and carries I/O', async () => {
      const handle = await spawnCatTerminal()
      expect(handle.pid).toBeGreaterThan(0)
      await waitForOutput(handle, 'term-ready')
      await handle.write('ping\n')
      await waitForOutput(handle, 'ping')
      expect(server.ptyRequests.at(-1)).toEqual({ cols: 80, rows: 24 })
      await handle.terminate()
      await expect(handle.done).resolves.toMatchObject({ exitCode: null })
    }, 20_000)

    it('inspects the foreground process group (Linux /proc input-wait fact)', async () => {
      const handle = await spawnCatTerminal()
      await waitForOutput(handle, 'term-ready')
      const foreground = await handle.inspectForeground()
      expect(foreground).toBeDefined()
      expect(foreground?.processGroupId).toBeGreaterThan(0)
      if (process.platform === 'linux') {
        expect(foreground?.inputWaiting).toBe(true)
      }
      await handle.terminate()
    }, 20_000)

    it('signals the foreground process group', async () => {
      const handle = await spawnCatTerminal()
      await waitForOutput(handle, 'term-ready')
      const group = await handle.signalForeground('SIGINT')
      expect(group).toBeGreaterThan(0)
      await expect(handle.done).resolves.toBeDefined()
    }, 20_000)

    it('resizes the remote window', async () => {
      const handle = await spawnCatTerminal()
      await waitForOutput(handle, 'term-ready')
      await handle.resize(100, 50)
      await handle.terminate()
      expect(server.windows.some(w => w.cols === 100 && w.rows === 50)).toBe(true)
    }, 20_000)

    it('aborts terminal allocation when the signal is already fired', async () => {
      const abort = new AbortController()
      abort.abort()
      await expect(ctx.subprocess.spawnTerminal({
        argv: ['sh', '-c', 'cat'],
        cwd: '/',
        rows: 24,
        cols: 80,
        terminalType: 'xterm',
        graceMs: 1_000,
        signal: abort.signal,
      })).rejects.toThrow()
    })

    it('terminates the whole session on dispose', async () => {
      const handle = await spawnCatTerminal()
      await waitForOutput(handle, 'term-ready')
      await fiber!.dispose()
      await expect(handle.done).resolves.toBeDefined()
    }, 20_000)
  })
})

/** Read one Readable to completion. */
async function readStream(stream: import('node:stream').Readable | undefined): Promise<string> {
  if (stream === undefined) return ''
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Wait until the terminal output has delivered a substring. */
async function waitForOutput(
  handle: { output: import('node:stream').Readable },
  expected: string,
  timeoutMs = 10_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for terminal output containing ${JSON.stringify(expected)}`))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8')
      if (text.includes(expected)) {
        cleanup()
        resolve()
      }
    }
    const onEnd = (): void => {
      if (text.includes(expected)) resolve()
      else reject(new Error(`terminal ended before ${JSON.stringify(expected)}`))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      handle.output.off('data', onData)
      handle.output.off('end', onEnd)
    }
    handle.output.on('data', onData)
    handle.output.on('end', onEnd)
  })
}
