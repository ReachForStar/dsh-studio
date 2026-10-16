/**
 * Unified local entry point: starts the full A2A stack (Kafka + three A2A gateways + the Web app) in the background, then launches the Desktop shell in the foreground.
 *
 * The A2A stack is idempotent (see deploy/a2a/stack.mjs), so unrelated components that are already up get skipped. Desktop gets its build via `pnpm run dev:desktop`.
 *
 * Required env (source first): AMAX_API_KEY / AMAX_MODEL / AMAX_BASE_URL (and DEEPSEEK_API_KEY for model calls). The script forwards the whole environment unchanged.
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'

const REPO_ROOT = resolve(import.meta.dirname, '..')

function run(command: string, args: readonly string[], cwd: string, label: string): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
    detached: false,
  })
  child.on('error', (err) => console.error(`[${label}] failed to start: ${err.message}`))
  child.on('exit', (code, signal) =>
    console.log(`[${label}] exited (code=${String(code ?? '(none)')} signal=${String(signal ?? '(none)')})`),
  )
  return child
}

const stack = run('node', ['deploy/a2a/stack.mjs', 'up'], REPO_ROOT, 'stack')
const desktop = run('pnpm', ['run', 'dev:desktop'], REPO_ROOT, 'desktop')

const shuttingDown = new Set<ChildProcess>()
const shutdown = (): void => {
  for (const child of [stack, desktop]) {
    if (!child.killed && !shuttingDown.has(child)) {
      shuttingDown.add(child)
      child.kill('SIGTERM')
    }
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', (error) => {
  console.error('dev-all: uncaught exception', error)
  shutdown()
  process.exit(1)
})