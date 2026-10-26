/**
 * Cua Driver installer: detect, download, and run the upstream install script.
 * @module
 */

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir, platform, arch } from 'node:os'
import { join, isAbsolute } from 'node:path'

/** Official CUA Driver install entry points. */
const OFFICIAL_INSTALL_SCRIPT = 'https://cua.ai/driver/install.sh'
const OFFICIAL_INSTALL_COMMAND = `curl -fsSL ${OFFICIAL_INSTALL_SCRIPT} | bash`
const OFFICIAL_INSTALL_SCRIPT_PS1 = 'irm https://cua.ai/driver/install.ps1 | iex'

/**
 * Install locations the official installers write, in the order they are tried.
 *
 * The installers put the executable under the user's home and append their
 * directory to a shell profile, so a process started before the install — a
 * desktop app, for instance — never sees it on `PATH`. Resolving these paths
 * makes a completed install visible without restarting from a login shell.
 * @returns candidate absolute paths for this platform.
 */
export function driverCandidates(): string[] {
  const home = homedir()
  const exe = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  // `packages/current` is the install home's stable link to the newest release.
  const current = join(home, '.cua-driver', 'packages', 'current', exe)
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA']
    return [
      ...local === undefined ? [] : [join(local, 'Programs', 'Cua', 'cua-driver', 'bin', exe)],
      current,
    ]
  }
  return [join(home, '.local', 'bin', exe), current]
}

/**
 * Resolve the executable a configured command names.
 *
 * An absolute path the operator configured wins, so an explicit choice is never
 * overridden. Otherwise the command is tried on `PATH` first, then the
 * installers' own locations: a driver installed after this process started is
 * on disk but not on the inherited `PATH`.
 * @param command - configured executable path or `PATH` command.
 * @returns every executable to probe, in order.
 */
export async function resolveDriverExecutables(command: string): Promise<string[]> {
  if (isAbsolute(command)) return [command]
  const candidates = await Promise.all(driverCandidates().map(async (candidate) => {
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // The candidate is absent; keep looking.
      return undefined
    }
  }))
  return [command, ...candidates.filter((candidate): candidate is string => candidate !== undefined)]
}

/** What one detection run found. */
export interface DriverDetection {
  /** Whether an executable answered. */
  readonly installed: boolean
  /** The version the executable reported, when it reported one. */
  readonly version: string | null
  /** The executable that answered, when one did. */
  readonly path: string | null
}

/**
 * Check whether a command is available and optionally capture its version.
 *
 * The configured command is tried first; the installers' own locations are
 * tried next, so a driver installed after this process started is still found.
 * @param command - executable to invoke with `--version`.
 * @returns whether it exited 0, the version it reported, and its path.
 */
export async function checkDriver(command: string): Promise<DriverDetection> {
  for (const executable of await resolveDriverExecutables(command)) {
    const version = await probeVersion(executable)
    if (version !== null) return { installed: true, version, path: executable }
  }
  return { installed: false, version: null, path: null }
}

/**
 * Run one candidate with `--version`.
 * @param executable - absolute path or `PATH` command.
 * @returns the reported version, or null when the candidate is not runnable.
 */
async function probeVersion(executable: string): Promise<string | null> {
  return await new Promise((resolve) => {
    // Windows resolves npm-installed `.cmd` shims only through a shell, and the
    // shell splits the command line at its first space, so an absolute path
    // such as `C:\Program Files\...` must be quoted to start at all.
    const throughShell = process.platform === 'win32'
    const child = spawn(throughShell ? `"${executable}"` : executable, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: throughShell,
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    // An executable that starts but never answers must not hold the check open.
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(null) }, 5000)
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) { resolve(null); return }
      const match = stdout.trim().match(/(\d+\.\d+\.\d+)/)
      resolve(match?.[1] ?? (stdout.trim() || 'unknown'))
    })
  })
}

/**
 * Platform descriptor for error messages and logging.
 * @returns The platform and architecture pair, such as `win32-x64`.
 */
export function platformDescriptor(): string {
  return `${platform()}-${arch()}`
}

/**
 * Download the upstream install script and execute it, streaming progress
 * lines as newline-delimited JSON: {"type":"log","line":"..."} or
 * {"type":"done","exitCode":0} or {"type":"error","message":"..."}.
 * @returns One newline-delimited JSON frame per progress line, then a terminal frame.
 */
export function runInstall(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream({
    start(controller) {
      const send = (obj: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`))
      }

      try {
        const isWindows = process.platform === 'win32'
        const child = isWindows
          ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', OFFICIAL_INSTALL_SCRIPT_PS1], {
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          : spawn('bash', ['-c', OFFICIAL_INSTALL_COMMAND], {
            stdio: ['ignore', 'pipe', 'pipe'],
          })

        send({ type: 'log', line: `Downloading and running ${OFFICIAL_INSTALL_SCRIPT}...` })

        const lineBuffer: string[] = []
        const flushLines = (source: Buffer, stream: 'stdout' | 'stderr'): void => {
          const text = source.toString()
          for (const char of text) {
            if (char === '\n' || char === '\r') {
              if (lineBuffer.length > 0) {
                const line = lineBuffer.join('')
                lineBuffer.length = 0
                send({ type: 'log', line: stream === 'stderr' ? `[stderr] ${line}` : line })
              }
            } else {
              lineBuffer.push(char)
            }
          }
        }

        child.stdout.on('data', (chunk: Buffer) => { flushLines(chunk, 'stdout') })
        child.stderr.on('data', (chunk: Buffer) => { flushLines(chunk, 'stderr') })

        child.on('error', (error) => {
          send({ type: 'error', message: error.message })
          controller.close()
        })

        child.on('exit', (code) => {
          if (lineBuffer.length > 0) {
            send({ type: 'log', line: lineBuffer.join('') })
          }
          send({ type: 'done', exitCode: code ?? -1 })
          controller.close()
        })
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        controller.close()
      }
    },
  })
}

/**
 * Readable.toWeb adapter for the install stream.
 * @returns The same progress stream `runInstall` produces.
 */
export function installStream(): ReadableStream<Uint8Array> {
  return runInstall()
}
