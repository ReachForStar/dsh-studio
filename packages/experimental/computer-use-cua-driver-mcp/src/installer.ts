/**
 * Cua Driver installer: detect, download, and run the upstream install script.
 * @module
 */

import { spawn } from 'node:child_process'
import { platform, arch } from 'node:os'

/** GitHub release tag pinned in cordis.patch.yml. */
const CUA_DRIVER_RELEASE_TAG = 'cua-driver-rs-v0.28.0'
const GITHUB_RELEASE_BASE = `https://github.com/trycua/cua/releases/download/${CUA_DRIVER_RELEASE_TAG}`

/** Install script name per platform. */
function installScriptName(): string {
  return process.platform === 'win32' ? 'install.ps1' : 'install.sh'
}

/**
 * Check whether a command is available in PATH and optionally capture its version.
 * @param command - Executable to invoke with `--version`.
 * @returns Whether it exited 0, plus the version it reported when it did.
 */
export async function checkDriver(command: string): Promise<{ installed: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
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
  const script = installScriptName()
  const url = `${GITHUB_RELEASE_BASE}/${script}`

  return new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`))
      }

      try {
        send({ type: 'log', line: `Downloading ${script} from ${CUA_DRIVER_RELEASE_TAG}...` })
        const response = await fetch(url, { redirect: 'follow' })
        if (!response.ok) {
          send({ type: 'error', message: `Failed to download install script: ${response.status} ${response.statusText}` })
          controller.close()
          return
        }
        const scriptContent = await response.text()

        const isWindows = process.platform === 'win32'
        const child = isWindows
          ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', scriptContent], {
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          : spawn('bash', ['-c', scriptContent], {
            stdio: ['ignore', 'pipe', 'pipe'],
          })

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
