/**
 * Git plumbing for one Arena comparison: isolated worktrees on a shared base
 * commit, per-contender diffs, and applying a chosen diff to the main checkout.
 *
 * Every command runs through the `subprocess` and `sandbox` capabilities with
 * the policy the caller resolved, so a confined deployment keeps its write
 * boundary. Commands carry no shell and strip the repository selectors that
 * would otherwise retarget a nested invocation at another checkout.
 *
 * @module @deepseek-ai/dsh-arena/git
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessCollectedOutputs } from '@deepseek-ai/dsh-subprocess'
import { deadline } from '@deepseek-ai/dsh-timeout'

/** Limits owned by one Arena git invocation. */
export interface GitLimits {
  /** Deadline for one command, including executable lookup and confinement. */
  timeoutMs: number
  /** Termination grace period for the managed process. */
  graceMs: number
  /** Maximum captured bytes per output stream. */
  maxOutputBytes: number
}

/** Repository selectors that must not leak into a spawned Git command. */
const GIT_SELECTORS: readonly string[] = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_GRAFT_FILE',
]

/** Clear inherited repository and command-line configuration. */
const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(GIT_SELECTORS.map(key => [key, undefined]))

/**
 * Run one Git command without a shell and return its captured stdout.
 * @param ctx - context exposing the subprocess and sandbox capabilities.
 * @param limits - complete command limits.
 * @param policy - resolved execution policy for this command.
 * @param cwd - canonical working directory.
 * @param argv - `git` subcommand followed by literal arguments.
 * @param signal - operation cancellation.
 * @returns trimmed standard output.
 * @throws {Error} when the command fails or its output exceeds the limit.
 */
export async function runGit(
  ctx: Context,
  limits: GitLimits,
  policy: SandboxExecutionPolicy,
  cwd: string,
  argv: readonly [string, ...string[]],
  signal: AbortSignal,
): Promise<string> {
  using timeout = deadline(signal, limits.timeoutMs, 'ARENA_GIT_TIMEOUT')
  timeout.signal.throwIfAborted()
  const program = await ctx.subprocess.resolveExecutable('git', undefined, timeout.signal)
  const command = [program, ...argv]
  const wrapped = policy.mode === 'danger-full-access'
    ? command
    : (await ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, timeout.signal)).argv
  timeout.signal.throwIfAborted()
  const child = ctx.subprocess.spawn({
    argv: wrapped,
    cwd,
    env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0' },
    signal: timeout.signal,
    graceMs: limits.graceMs,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: limits.maxOutputBytes },
      stderr: { maxBytes: limits.maxOutputBytes },
    },
  })
  try {
    const outcome = await child.done
    timeout.signal.throwIfAborted()
    const captured = child.collected as Required<SubprocessCollectedOutputs>
    const stdout = captured.stdout.readFrom(0)
    const stderr = captured.stderr.readFrom(0)
    if (outcome.exitCode === null || outcome.exitCode !== 0) {
      throw new Error(`arena git ${argv.join(' ')} failed (${outcome.signal ?? String(outcome.exitCode)}): ${stderr.text.trim()}`)
    }
    if (stdout.lossy) throw new Error('arena git output exceeds maxOutputBytes')
    return stdout.text.trim()
  } finally {
    child.terminate()
    await child.waitForExit()
  }
}

/** One contender's checkout on the shared base commit. */
export interface ArenaWorktree {
  /** Absolute checkout path. */
  readonly path: string
  /** Branch created for this contender. */
  readonly branch: string
}

/**
 * Create one detached branch and its checkout at `baseCommit`.
 * @param ctx - context exposing the git capabilities.
 * @param limits - complete command limits.
 * @param policy - resolved execution policy.
 * @param repositoryRoot - checkout the branch is created in.
 * @param worktree - destination path and branch name.
 * @param baseCommit - resolved commit object name.
 * @param signal - operation cancellation.
 */
export async function addWorktree(
  ctx: Context,
  limits: GitLimits,
  policy: SandboxExecutionPolicy,
  repositoryRoot: string,
  worktree: ArenaWorktree,
  baseCommit: string,
  signal: AbortSignal,
): Promise<void> {
  await runGit(
    ctx, limits, policy, repositoryRoot,
    ['worktree', 'add', '-b', worktree.branch, worktree.path, baseCommit],
    signal,
  )
}

/**
 * Remove one contender's checkout and branch, ignoring a missing registration.
 * @param ctx - context exposing the git capabilities.
 * @param limits - complete command limits.
 * @param policy - resolved execution policy.
 * @param repositoryRoot - checkout that owns the worktree registration.
 * @param worktree - checkout to remove.
 * @param signal - operation cancellation.
 */
export async function removeWorktree(
  ctx: Context,
  limits: GitLimits,
  policy: SandboxExecutionPolicy,
  repositoryRoot: string,
  worktree: ArenaWorktree,
  signal: AbortSignal,
): Promise<void> {
  await runGit(ctx, limits, policy, repositoryRoot, ['worktree', 'remove', '--force', worktree.path], signal)
  await runGit(ctx, limits, policy, repositoryRoot, ['branch', '-D', worktree.branch], signal)
}

/**
 * List the paths one checkout changed relative to `baseCommit`.
 * @param ctx - context exposing the git capabilities.
 * @param limits - complete command limits.
 * @param policy - resolved execution policy.
 * @param worktreePath - contender checkout to inspect.
 * @param baseCommit - commit the diff is taken against.
 * @param signal - operation cancellation.
 * @returns sorted changed paths; empty when the contender changed nothing.
 */
export async function changedPaths(
  ctx: Context,
  limits: GitLimits,
  policy: SandboxExecutionPolicy,
  worktreePath: string,
  baseCommit: string,
  signal: AbortSignal,
): Promise<string[]> {
  // Staging first makes new files part of the comparison; a model that never
  // commits still produces a complete diff.
  await runGit(ctx, limits, policy, worktreePath, ['add', '--all'], signal)
  const output = await runGit(
    ctx, limits, policy, worktreePath, ['diff', '--cached', '--name-only', baseCommit], signal,
  )
  return output.length === 0 ? [] : output.split('\n').map(line => line.trim()).filter(line => line.length > 0).sort()
}

/**
 * Apply one contender's diff to the main checkout.
 * @param ctx - context exposing the git capabilities.
 * @param limits - complete command limits.
 * @param policy - resolved execution policy for the main checkout.
 * @param repositoryRoot - checkout receiving the change.
 * @param patchPath - file holding the contender's diff.
 * @param signal - operation cancellation.
 */
export async function applyPatch(
  ctx: Context,
  limits: GitLimits,
  policy: SandboxExecutionPolicy,
  repositoryRoot: string,
  patchPath: string,
  signal: AbortSignal,
): Promise<void> {
  await runGit(ctx, limits, policy, repositoryRoot, ['apply', '--whitespace=nowarn', patchPath], signal)
}

/**
 * Write one contender's diff to a file inside its run directory.
 * @param ctx - context exposing the filesystem.
 * @param worktreePath - contender checkout the diff is taken in.
 * @param limits - complete command limits.
 * @param policy - resolved execution policy.
 * @param baseCommit - commit the diff is taken against.
 * @param patchPath - destination file for the patch.
 * @param signal - operation cancellation.
 */
export async function writePatch(
  ctx: Context,
  limits: GitLimits,
  policy: SandboxExecutionPolicy,
  worktreePath: string,
  baseCommit: string,
  patchPath: string,
  signal: AbortSignal,
): Promise<void> {
  await runGit(ctx, limits, policy, worktreePath, ['add', '--all'], signal)
  const patch = await runGit(ctx, limits, policy, worktreePath, ['diff', '--cached', baseCommit], signal)
  // `git apply` rejects a patch whose final hunk lacks its trailing newline.
  await ctx.fs.writeText(await ctx.fs.resolve(patchPath), patch.length === 0 ? '' : `${patch}\n`)
}

/** Name of the patch file written for one applied contender. */
export const APPLIED_PATCH = 'winner.patch'

/**
 * Patch path for one run directory.
 * @param runDirectory - absolute directory holding the run's checkouts.
 * @returns the absolute patch file path.
 */
export function patchPathOf(runDirectory: string): string {
  return join(runDirectory, APPLIED_PATCH)
}
