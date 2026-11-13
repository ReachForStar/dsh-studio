import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  addWorktree,
  applyPatch,
  changedPaths,
  patchPathOf,
  removeWorktree,
  runGit,
  writePatch,
  type GitLimits,
} from '../src/git.ts'

/** Real Git worktrees: each case pays for several process spawns, so it gets its own budget. */
function gitTest(name: string, body: () => Promise<void>): void {
  it(name, body, 60_000)
}

const LIMITS: GitLimits = { timeoutMs: 30_000, graceMs: 2_000, maxOutputBytes: 1_048_576 }

let root: string
let repository: string
let checkouts: string
const contexts: Context[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-arena-git-'))
  repository = join(root, 'repo')
  checkouts = join(root, 'checkouts')
  await writeFile(join(root, 'seed.txt'), 'seed')
  execFileSync('git', ['init', '--quiet', repository])
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'arena@example.com'])
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'Arena'])
  await writeFile(join(repository, 'a.txt'), 'one\n')
  execFileSync('git', ['-C', repository, 'add', '.'])
  execFileSync('git', ['-C', repository, 'commit', '--quiet', '-m', 'base'])
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await rm(root, { recursive: true, force: true })
})

/** Mount the real process, sandbox, and filesystem capabilities. */
async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: repository })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(Sandbox)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: repository })
  const policy: SandboxExecutionPolicy = ctx.sandboxPolicy.resolve()
  return { ctx, policy }
}

describe('runGit', () => {
  gitTest('returns trimmed standard output', async () => {
    const { ctx, policy } = await harness()
    const base = await runGit(ctx, LIMITS, policy, repository, ['rev-parse', 'HEAD'], new AbortController().signal)
    expect(base).toMatch(/^[0-9a-f]{40}$/u)
  })

  gitTest('reports the command and stderr when Git fails', async () => {
    const { ctx, policy } = await harness()
    await expect(runGit(
      ctx, LIMITS, policy, repository, ['rev-parse', 'no-such-ref'], new AbortController().signal,
    )).rejects.toThrow('arena git rev-parse no-such-ref failed')
  })

  gitTest('rejects output above the byte cap', async () => {
    const { ctx, policy } = await harness()
    await expect(runGit(
      ctx, { ...LIMITS, maxOutputBytes: 8 }, policy, repository, ['--version'], new AbortController().signal,
    )).rejects.toThrow('exceeds maxOutputBytes')
  })

  gitTest('stops before spawning once the caller aborts', async () => {
    const { ctx, policy } = await harness()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(runGit(
      ctx, LIMITS, policy, repository, ['rev-parse', 'HEAD'], controller.signal,
    )).rejects.toThrow('cancelled')
  })

  gitTest('runs through the confinement path when the policy is not full access', async () => {
    const { ctx } = await harness()
    const confined: SandboxExecutionPolicy = { ...ctx.sandboxPolicy.resolve(), mode: 'workspace-write' }
    await expect(runGit(
      ctx, LIMITS, confined, repository, ['rev-parse', 'HEAD'], new AbortController().signal,
    )).resolves.toMatch(/^[0-9a-f]{40}$/u)
  })
})

describe('worktree lifecycle', () => {
  /** One worktree under the shared checkout directory. */
  function worktree(name = 'alpha') {
    return { path: join(checkouts, name), branch: `arena/run/${name}` }
  }

  gitTest('creates, diffs, applies, and removes one contender checkout', async () => {
    const { ctx, policy } = await harness()
    const signal = new AbortController().signal
    const base = await runGit(ctx, LIMITS, policy, repository, ['rev-parse', 'HEAD'], signal)
    const target = worktree()
    await addWorktree(ctx, LIMITS, policy, repository, target, base, signal)
    expect((await readFile(join(target.path, 'a.txt'), 'utf8'))).toBe('one\n')

    expect(await changedPaths(ctx, LIMITS, policy, target.path, base, signal)).toEqual([])
    await writeFile(join(target.path, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(target.path, 'b.txt'), 'new\n')
    expect(await changedPaths(ctx, LIMITS, policy, target.path, base, signal)).toEqual(['a.txt', 'b.txt'])

    const patchPath = patchPathOf(checkouts)
    await writePatch(ctx, LIMITS, policy, target.path, base, patchPath, signal)
    await applyPatch(ctx, LIMITS, policy, repository, patchPath, signal)
    expect(await readFile(join(repository, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(await readFile(join(repository, 'b.txt'), 'utf8')).toBe('new\n')

    await removeWorktree(ctx, LIMITS, policy, repository, target, signal)
    await expect(readFile(join(target.path, 'a.txt'), 'utf8')).rejects.toThrow()
  })

  gitTest('writes an empty patch when the contender changed nothing', async () => {
    const { ctx, policy } = await harness()
    const signal = new AbortController().signal
    const base = await runGit(ctx, LIMITS, policy, repository, ['rev-parse', 'HEAD'], signal)
    const target = worktree()
    await addWorktree(ctx, LIMITS, policy, repository, target, base, signal)
    const patchPath = patchPathOf(checkouts)
    await writePatch(ctx, LIMITS, policy, target.path, base, patchPath, signal)
    expect(await readFile(patchPath, 'utf8')).toBe('')
  })

  gitTest('refuses a duplicate checkout path', async () => {
    const { ctx, policy } = await harness()
    const signal = new AbortController().signal
    const base = await runGit(ctx, LIMITS, policy, repository, ['rev-parse', 'HEAD'], signal)
    const target = worktree()
    await addWorktree(ctx, LIMITS, policy, repository, target, base, signal)
    await expect(addWorktree(ctx, LIMITS, policy, repository, target, base, signal)).rejects.toThrow('arena git worktree add')
  })
})
