/**
 * The memory write tool: append one durable note to the project or user
 * MEMORY.md. Writes serialize per file and reject credential-like text, so a
 * failed or suspicious note never reaches the next note injection.
 * @module @deepseek-ai/dsh-memory-notes/write
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolArgsError, defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { userMemoryDirectory } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { findProjectRoot } from './files.ts'

/** Credential-shaped text the tool refuses to persist. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:sk|rk)-[A-Za-z0-9_-]{16,}/u,
  /gh[pousr]_[A-Za-z0-9]{20,}/u,
  /AKIA[0-9A-Z]{16}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:password|passwd|secret|token)\s*[:=]\s*\S{8,}/iu,
]

/** One in-flight write per memory file; the next append follows it. */
const locks = new Map<string, Promise<void>>()

/** A memory file write found a live lock from another writer. */
export class MemoryLockedError extends Error {
  /** Stable machine-routable failure class. */
  readonly code = 'MEMORY_LOCKED'

  /**
   * @param path - memory file whose lock could not be taken.
   */
  constructor(path: string) {
    super(`memory file "${path}" is locked by another writer; remove its .lock sibling if no writer is active`)
    this.name = 'MemoryLockedError'
  }
}

/** Take a lock file beside `path`, reclaiming an abandoned local lock. */
async function withLocalLock<T>(path: string, staleMs: number, run: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`
  await mkdir(dirname(path), { recursive: true })
  const token = `${String(process.pid)}:${String(Date.now())}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, token, { flag: 'wx' })
      break
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 'EEXIST' || attempt === 1) throw new MemoryLockedError(path)
      const age = Date.now() - (await stat(lockPath)).mtimeMs
      if (age < staleMs) throw new MemoryLockedError(path)
      await rm(lockPath, { force: true })
    }
  }
  try {
    return await run()
  } finally {
    // The note is already committed when only the release fails; the retained
    // lock is what the next writer reports as `MEMORY_LOCKED`.
    await rm(lockPath, { force: true }).catch(() => {})
  }
}

/** Take the same lock through the filesystem seam; remote stales are the operator's to clear. */
async function withFsSeamLock<T>(
  fs: FileSystem,
  path: string,
  cwd: string,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = `${path}.lock`
  try {
    const target = await fs.resolve(lockPath, { cwd, signal })
    await fs.writeBytes(target, new TextEncoder().encode(`${String(process.pid)}:${String(Date.now())}`),
      { kind: 'createIfAbsent' }, signal)
  } catch (error: unknown) {
    if (error instanceof MemoryLockedError) throw error
    throw new MemoryLockedError(path)
  }
  try {
    return await run()
  } finally {
    await fs.remove(lockPath, { cwd }, signal).catch(() => {})
  }
}

/** Append one bullet under a per-file lock, creating the file on first use. */
async function appendBullet(path: string, text: string, lockStaleMs: number): Promise<void> {
  const previous = locks.get(path) ?? Promise.resolve()
  const run = previous.then(() => withLocalLock(path, lockStaleMs, async () => {
    let existing = ''
    try {
      existing = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    }
    const prefix = existing.length === 0
      ? '# Memory\n\n'
      : existing.endsWith('\n') ? existing : `${existing}\n`
    await writeFile(path, `${prefix}- ${text.trim()}\n`, 'utf8')
  }))
  locks.set(path, run.catch(() => {}))
  await run
}

/** Append one bullet through the filesystem seam, guarded by the file's version. */
async function appendBulletViaFs(
  fs: FileSystem,
  path: string,
  cwd: string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const previous = locks.get(path) ?? Promise.resolve()
  const run = previous.then(() => withFsSeamLock(fs, path, cwd, signal, async () => {
    const target = await fs.resolve(path, { cwd, signal })
    const info = await fs.stat(target, signal)
    const existing = info === undefined ? '' : await fs.readText(target, signal)
    const prefix = existing.length === 0
      ? '# Memory\n\n'
      : existing.endsWith('\n') ? existing : `${existing}\n`
    await fs.writeBytes(target, new TextEncoder().encode(`${prefix}- ${text.trim()}\n`),
      info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version }, signal)
  }))
  locks.set(path, run.catch(() => {}))
  await run
}

/**
 * Register the `memory_write` tool when both the tool registry and a
 * filesystem are composed.
 * @param ctx - plugin scope.
 * @param config - normalized memory configuration.
 */
export function registerMemoryWriteTool(ctx: Context, config: ResolvedConfig): void {
  const tools = ctx.get('tools')
  const fs = ctx.get('fs')
  if (tools === undefined || fs === undefined) return
  tools.register(defineTool({
    name: 'memory_write',
    description: 'Append one durable note to MEMORY.md so later sessions recall it. '
        + 'Use the project scope for repository facts and the user scope for preferences that follow you across projects.',
    parameters: {
      scope: {
        type: 'string', required: true,
        description: 'Which note file to append to: "project" for the nearest project root, "user" for the personal memory directory.',
      },
      text: {
        type: 'string', required: true,
        description: 'One self-contained fact or preference, at most a short paragraph. Do not include credentials.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args: { scope: string; text: string }, exec: ToolRunContext): Promise<string> {
      if (args.scope !== 'project' && args.scope !== 'user') {
        throw new ToolArgsError(['scope must be "project" or "user"'])
      }
      const text = args.text.trim()
      if (text.length === 0) throw new ToolArgsError(['text must be a non-empty string'])
      if (Array.from(text).length > config.maxWriteChars) {
        throw new ToolArgsError([`text exceeds maxWriteChars (${String(config.maxWriteChars)})`])
      }
      if (SECRET_PATTERNS.some(pattern => pattern.test(text))) {
        throw new ToolArgsError(['text looks like a credential or secret; remove it before saving'])
      }
      if (args.scope === 'user') {
        const path = join(userMemoryDirectory(), config.memoryFileNames[0] ?? 'MEMORY.md')
        await appendBullet(path, text, config.lockStaleMs)
        return `Saved to user memory (${path}).`
      }
      const agent = exec.agent
      if (agent === undefined) throw new Error('memory_write requires an agent to resolve the project directory')
      const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
      const root = await findProjectRoot(cwd, config.projectRootMarkers, fs, exec.signal) ?? cwd
      const path = join(root, config.memoryFileNames[0] ?? 'MEMORY.md')
      await appendBulletViaFs(fs, path, cwd, text, exec.signal)
      return `Saved to project memory (${path}).`
    },
  }))
}
