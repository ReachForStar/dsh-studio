/**
 * The memory write tool: append one durable note to the project or user
 * MEMORY.md. Writes serialize per file and reject credential-like text, so a
 * failed or suspicious note never reaches the next note injection.
 * @module @deepseek-ai/dsh-memory-notes/write
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

/** Append one bullet under a per-file lock, creating the file on first use. */
async function appendBullet(path: string, text: string): Promise<void> {
  const previous = locks.get(path) ?? Promise.resolve()
  const run = previous.then(async () => {
    let existing = ''
    try {
      existing = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    }
    await mkdir(dirname(path), { recursive: true })
    const prefix = existing.length === 0
      ? '# Memory\n\n'
      : existing.endsWith('\n') ? existing : `${existing}\n`
    await writeFile(path, `${prefix}- ${text.trim()}\n`, 'utf8')
  })
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
  const run = previous.then(async () => {
    const target = await fs.resolve(path, { cwd, signal })
    const info = await fs.stat(target, signal)
    const existing = info === undefined ? '' : await fs.readText(target, signal)
    const prefix = existing.length === 0
      ? '# Memory\n\n'
      : existing.endsWith('\n') ? existing : `${existing}\n`
    await fs.writeBytes(target, new TextEncoder().encode(`${prefix}- ${text.trim()}\n`),
      info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version }, signal)
  })
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
        await appendBullet(path, text)
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
