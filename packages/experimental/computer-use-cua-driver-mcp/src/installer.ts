/**
 * Cua Driver installer: detect, download, and run the upstream install script.
 * @module
 */

import { spawn } from 'node:child_process'
import { platform, arch } from 'node:os'

/** Official CUA Driver install entry points. */
const OFFICIAL_INSTALL_SCRIPT = 'https://cua.ai/driver/install.sh'
const OFFICIAL_INSTALL_COMMAND = `curl -fsSL ${OFFICIAL_INSTALL_SCRIPT} | bash`
const OFFICIAL_INSTALL_SCRIPT_PS1 = 'irm https://cua.ai/driver/install.ps1 | iex'

/**
 * Check whether a command is available in PATH and optionally capture its version.
 * @param command - Executable to invoke with `--version`.
 * @returns Whether it exited 0, plus the version it reported when it did.
 */
export async function checkDriver(command: string): Promise<{ installed: boolean; version: string | null }> {
  return new Promise((resolve) => {
    // Windows resolves npm-installed `.cmd` shims only through a shell, and the
    // shell splits the command line at its first space, so an absolute path
    // such as `C:\Program Files\...` must be quoted to start at all.
    const throughShell = process.platform === 'win32'
    const child = spawn(throughShell ? `"${command}"` : command, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: throughShell,
    })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve({ installed: false, version: null }) }, 5000)
    child.on('error', () => { clearTimeout(timer); resolve({ installed: false, version: null }) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        const match = stdout.trim().match(/(\d+\.\d+\.\d+)/)
        resolve({ installed: true, version: match?.[1] ?? (stdout.trim() || null) })
      } else {
        resolve({ installed: false, version: null })
      }
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
    async start(controller) {
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

        child.stdout?.on('data', (chunk: Buffer) => flushLines(chunk, 'stdout'))
        child.stderr?.on('data', (chunk: Buffer) => flushLines(chunk, 'stderr'))

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
