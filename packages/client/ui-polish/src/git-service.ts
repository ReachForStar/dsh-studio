/**
 * Git panel host service: a REST surface over the repositories under a
 * workspace. Executes `git` through `spawn` with array arguments (no shell)
 * and `GIT_TERMINAL_PROMPT=0`, so paths and messages never reach a shell and
 * a missing credential fails fast instead of hanging on a prompt.
 *
 * Routes (all under `/git`, registered by the plugin apply):
 *
 *  - `GET  /git/repos?cwd=&refresh=` → git repositories discovered under the
 *                                     workspace (BFS, nested + worktrees).
 *  - `GET  /git/status?cwd=`         → branch, upstream, ahead/behind, merge state,
 *                                     and working-tree files grouped by staged /
 *                                     unstaged / untracked / conflict.
 *  - `GET  /git/log?cwd=&skip=&limit=&stat=` → paged commits with parents (graph).
 *  - `GET  /git/branches?cwd=`       → current + local + remote branches.
 *  - `GET  /git/show?cwd=&hash=`     → a commit's full message + per-file add/del.
 *  - `GET  /git/blob?cwd=&path=&source=head|index|worktree` → a file version's
 *                                     bytes as a data URL (image diff preview).
 *  - `GET  /git/models`              → the LLM provider/model catalog for the
 *                                     generation model picker.
 *  - `GET  /git/rules?cwd=&repo=`    → the effective commit rule (repo > global > builtin).
 *  - `POST /git/stage`      {cwd, paths[]}   → `git add -A -- <paths>` (stdin pathspec for long lists).
 *  - `POST /git/unstage`    {cwd, paths[]}   → `git reset -q -- <paths>`.
 *  - `POST /git/discard`    {cwd, paths[], staged?} → `git restore` (worktree or +index).
 *  - `POST /git/clean`      {cwd, paths[]}   → `git clean -f -- <paths>` (untracked only).
 *  - `POST /git/diff`       {cwd, path, staged?, untracked?} → unified diff text.
 *  - `POST /git/commit`     {cwd, message}   → `git commit -F -` (message via stdin; stages
 *                                     nothing — explicit staging is the panel's job).
 *  - `POST /git/undo-commit`{cwd, hash}      → `git reset --soft HEAD~1`, only when HEAD is `hash`.
 *  - `POST /git/push`       {cwd}            → `git push`.
 *  - `POST /git/pull`       {cwd}            → `git fetch --all --prune` + `git merge --no-edit @{u}`
 *                                     (fetch-only when there is no upstream).
 *  - `POST /git/switch`     {cwd, branch, create?} → `git switch [-c] <branch>`.
 *  - `POST /git/stash`      {cwd, op, message?}    → list / push / pop.
 *  - `POST /git/merge-abort`{cwd}           → `git merge --abort`.
 *  - `POST /git/merge-complete` {cwd}       → `git commit --no-edit` (concludes a merge
 *                                     whose conflicts are all resolved but leave no staged diff).
 *  - `POST /git/reset`      {cwd, mode}      → `git reset --soft|mixed|hard HEAD`.
 *  - `POST /git/rules-save` {cwd, repo, scope, systemPrompt, userContext} → persist a rule.
 *  - `POST /git/rules-reset`{cwd, repo, scope} → delete the repo rule / the global rule.
 *  - `POST /git/generate`   {cwd, token, model?} → LLM commit message from the effective
 *                                     rule + staged diff, streamed as NDJSON lines
 *                                     `{"t":"text"|"done"|"stop"|"err", ...}`.
 *  - `POST /git/generate-cancel` {token}     → abort an in-flight generation.
 *
 * The target directory is chosen per request from `cwd`, which the host resolves
 * against its known workspace paths — an unknown directory is rejected, so the
 * surface can never be pointed at an arbitrary path. JSON routes answer with an
 * `error` field on failure. Write operations are appended to the audit log
 * under `$DSH_HOME/git-panel/logs/`; rules live under `$DSH_HOME/git-panel/rules/`.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { writeFile as writeFileNode } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import yaml from 'js-yaml'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_DIFF_BYTES = 4 * 1024 * 1024
/** Staged-diff cap injected into the generation prompt (120 KB). */
const MAX_STAGED_DIFF_BYTES = 120 * 1024
/** Image preview cap per file version (8 MB). */
const MAX_BLOB_BYTES = 8 * 1024 * 1024
/** Above this total path length, pathspecs go through `--pathspec-from-file=-`. */
const PATHSPEC_STDIN_THRESHOLD = 2000

// ---------------------------------------------------------------------------
// git execution
// ---------------------------------------------------------------------------

interface GitRunOptions {
  readonly cwd: string
  readonly args: readonly string[]
  /** Exact bytes written to the child's stdin before closing it. */
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly maxBuffer?: number
}

/**
 * Run one git command: array arguments, no shell, terminal prompts disabled,
 * bounded stdout, and a timeout that kills the child.
 * @param options - cwd, arguments, optional stdin and limits.
 * @returns the stdout text on a zero exit.
 * @throws with the git stderr text on a non-zero exit.
 */
function gitRun(options: GitRunOptions): Promise<string> {
  return gitRunTolerant(options).then(({ stdout, stderr, code }) => {
    if (code === 0) return stdout
    throw new Error(`git ${options.args.slice(0, 2).join(' ')} failed: ${(stderr.trim().length > 0 ? stderr : stdout).trim()}`)
  })
}

/**
 * Run one git command, resolving with stdout on any exit code; rejects only
 * on spawn failure, timeout, or an unbounded output.
 * @param options - cwd, arguments, optional stdin and limits.
 * @returns the stdout text, the stderr text, and the exit code.
 */
function gitRunTolerant(options: GitRunOptions): Promise<{ stdout: string; stderr: string; code: number }> {
  const { cwd, args, stdin, timeoutMs = 30_000, maxBuffer = MAX_DIFF_BYTES } = options
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('git', [...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectRun(error)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      fail(new Error(`git ${args[0]} ${args[1] ?? ''} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > maxBuffer) {
        child.kill('SIGKILL')
        fail(new Error(`git ${args[0]} ${args[1] ?? ''} output exceeds ${maxBuffer} bytes`))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > maxBuffer) {
        child.kill('SIGKILL')
        fail(new Error(`git ${args[0]} ${args[1] ?? ''} output exceeds ${maxBuffer} bytes`))
      }
    })
    child.on('error', (error) => { fail(error) })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ stdout, stderr, code: code ?? -1 })
    })
    if (stdin !== undefined) {
      child.stdin.on('error', (error) => {
        // EPIPE when git closes stdin early (e.g. nothing to commit): the
        // close handler owns the real result.
        void error
      })
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}

/** Run git, rejecting on a non-zero exit (see {@link gitRun}). */
async function git(cwd: string, args: readonly string[], timeoutMs?: number): Promise<string> {
  return gitRun({ cwd, args, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
}

/** Run git, returning stdout regardless of the exit code. */
async function gitLenient(cwd: string, args: readonly string[], timeoutMs?: number): Promise<string> {
  const out = await gitRunTolerant({ cwd, args, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
  return out.stdout
}

/** Read a git blob (`<ref>:<path>`) as bytes. */
async function gitShowBuffer(cwd: string, ref: string): Promise<Buffer> {
  return new Promise((resolveShow, rejectShow) => {
    const child = spawn('git', ['show', ref], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      if (!settled) {
        settled = true
        rejectShow(new Error(`git show ${ref} timed out`))
      }
    }, 30_000)
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      const total = chunks.reduce((n, c) => n + c.byteLength, 0)
      if (total > MAX_BLOB_BYTES) {
        child.kill('SIGKILL')
        if (!settled) {
          settled = true
          clearTimeout(timer)
          rejectShow(new Error(`git show ${ref} exceeds ${MAX_BLOB_BYTES} bytes`))
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        rejectShow(error)
      }
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolveShow(Buffer.concat(chunks))
      else rejectShow(new Error(`git show ${ref} failed: ${stderr.trim()}`))
    })
  })
}

/** Stage the given paths, using a NUL-separated stdin pathspec for long lists. */
async function addPaths(cwd: string, paths: readonly string[]): Promise<void> {
  const total = paths.reduce((n, p) => n + p.length + 1, 0)
  if (total > PATHSPEC_STDIN_THRESHOLD) {
    await gitRun({ cwd, args: ['add', '-A', '--pathspec-from-file=-', '--null'], stdin: `${paths.join('\0')}\0` })
  } else {
    await gitRun({ cwd, args: ['add', '-A', '--', ...paths] })
  }
}

/** Unstage the given paths (same stdin threshold as {@link addPaths}). */
async function resetPaths(cwd: string, paths: readonly string[]): Promise<void> {
  const total = paths.reduce((n, p) => n + p.length + 1, 0)
  if (total > PATHSPEC_STDIN_THRESHOLD) {
    await gitRun({ cwd, args: ['reset', '-q', '--pathspec-from-file=-', '--null'], stdin: `${paths.join('\0')}\0` })
  } else {
    await gitRun({ cwd, args: ['reset', '-q', '--', ...paths] })
  }
}

// ---------------------------------------------------------------------------
// repository discovery
// ---------------------------------------------------------------------------

/** One discovered repository. */
export interface GitRepo {
  /** Absolute repository path (the workspace root itself when it is a repo). */
  readonly path: string
  readonly name: string
  /** True for git worktrees (`.git` is a file, not a directory). */
  readonly isWorktree: boolean
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', '.svn', '.hg', '.venv', 'venv'])
const SCAN_MAX_DEPTH = 10
const SCAN_MAX_DIRS = 2000
const SCAN_MAX_REPOS = 50
const SCAN_CACHE_TTL_MS = 60_000

/** In-memory scan cache: workspace root → (timestamp, repos). */
const scanCache = new Map<string, { at: number; repos: GitRepo[] }>()

function isGitRepo(dir: string): boolean {
  try {
    statSync(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

function isGitWorktree(dir: string): boolean {
  try {
    return statSync(join(dir, '.git')).isFile()
  } catch {
    return false
  }
}

/**
 * BFS-discover git repositories under `root` (nested repos and worktrees
 * included), skipping heavy directories and bounded by depth/dirs/repos.
 * @param root - the workspace directory.
 * @returns the repositories, the workspace root first when it is a repo.
 */
export function findRepos(root: string): GitRepo[] {
  const repos: GitRepo[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  let dirs = 0
  while (queue.length > 0 && repos.length < SCAN_MAX_REPOS && dirs < SCAN_MAX_DIRS) {
    const item = queue.shift() as { dir: string; depth: number }
    dirs += 1
    if (isGitRepo(item.dir)) {
      repos.push({ path: item.dir, name: basename(item.dir) || root, isWorktree: isGitWorktree(item.dir) })
    }
    if (item.depth >= SCAN_MAX_DEPTH) continue
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(item.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git' || SKIP_DIRS.has(entry.name)) continue
      queue.push({ dir: join(item.dir, entry.name), depth: item.depth + 1 })
    }
  }
  repos.sort((a, b) =>
    a.path === root ? -1 : b.path === root ? 1 : a.path.localeCompare(b.path))
  return repos
}

/** Cached discovery: fresh within the TTL, a full scan otherwise.
 * @param root - the workspace directory.
 * @param refresh - bypass the cache and force a full scan.
 * @returns the repositories.
 */
export function findReposCached(root: string, refresh: boolean): GitRepo[] {
  const cached = scanCache.get(root)
  if (!refresh && cached !== undefined && Date.now() - cached.at < SCAN_CACHE_TTL_MS) {
    return cached.repos
  }
  const repos = findRepos(root)
  scanCache.set(root, { at: Date.now(), repos })
  return repos
}

// ---------------------------------------------------------------------------
// commit rules
// ---------------------------------------------------------------------------

/** A commit rule: the LLM's system prompt and user-context template. */
export interface GitRule {
  readonly systemPrompt: string
  readonly userContext: string
}

/** The rule in force for a repository, with the file it was read from. */
export interface GitRulesResult extends GitRule {
  /** Where the text came from: a repo-specific file, the global file, or the builtin. */
  readonly source: 'repo' | 'global' | 'builtin'
  /** The registry's per-repo source preference (unset when the registry has no entry). */
  readonly scope: 'global' | 'repo' | 'unset'
}

/** Builtin default: Conventional Commits, message language follows the files. */
export const BUILTIN_RULE: GitRule = {
  systemPrompt: [
    'You generate git commit messages.',
    'Follow Conventional Commits: type(scope): subject, with a type from',
    'feat/fix/docs/style/refactor/perf/test/build/ci/chore, a lowercase optional',
    'scope, and an imperative subject of at most 50 characters without a period.',
    'Write the message in the same language the changed file contents use (Chinese',
    'for Chinese content, English otherwise).',
    'Add a body only when the change needs context beyond the subject: a bullet list',
    'of 3-8 logical changes, one per line starting with "- ", each under 72 characters.',
    'A footer is only for a breaking change or an issue reference.',
    'Output the commit message text only: no code fences, no explanations, no',
    'leading bullets, no markdown markers; identifiers and paths are written bare.',
  ].join(' '),
  userContext: [
    'Repository: {repo_name}',
    'Branch: {branch}',
    'Staged files:',
    '{file_list}',
    '',
    'Staged diff:',
    '{staged_diff}',
  ].join('\n'),
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function rulesDir(): string {
  return dshHomePath('git-panel', 'rules')
}

function registryPath(): string {
  return dshHomePath('git-panel', 'git-repos.json')
}

/**
 * The rule file key for a repository: name + 8-hex hash of its absolute path.
 * @param repoName - repository directory name.
 * @param repoPath - repository absolute path.
 * @returns the stable rule key.
 */
export function ruleKey(repoName: string, repoPath: string): string {
  return `${repoName}-${fnv1a(normalizeSlashes(resolve(repoPath)))}`
}

interface RegistryEntry {
  readonly path: string
  readonly ruleScope: 'global' | 'repo'
}

interface Registry extends Record<string, RegistryEntry> {}

async function readRegistry(): Promise<Registry> {
  try {
    return JSON.parse(await readFile(registryPath(), 'utf8')) as Registry
  } catch {
    return {}
  }
}

async function writeRegistryEntry(key: string, value: RegistryEntry): Promise<void> {
  const registry = await readRegistry()
  registry[key] = value
  await mkdir(dirname(registryPath()), { recursive: true })
  await writeFile(registryPath(), `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
}

async function deleteRegistryEntry(key: string): Promise<void> {
  const registry = await readRegistry()
  if (!(key in registry)) return
  const next: Registry = {}
  for (const [entryKey, entry] of Object.entries(registry)) {
    if (entryKey !== key) next[entryKey] = entry
  }
  await mkdir(dirname(registryPath()), { recursive: true })
  await writeFile(registryPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

/** Read one rule file; null when absent or invalid. */
async function readRuleFile(file: string): Promise<GitRule | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const doc = yaml.load(raw) as Record<string, unknown> | null
    if (doc === null || typeof doc !== 'object') return null
    const systemPrompt = typeof doc.system_prompt === 'string' ? doc.system_prompt : ''
    const userContext = typeof doc.user_context === 'string' ? doc.user_context : ''
    if (systemPrompt.length === 0) return null
    return { systemPrompt, userContext }
  } catch {
    return null
  }
}

/**
 * Resolve the effective rule for a repository: the registry preference decides
 * between the repo file and the global file, absent/invalid files fall back
 * toward the builtin, and an unregistered repo prefers its own file when present.
 * @param repoName - the repository's directory name.
 * @param repoPath - the repository's absolute path (keys the per-repo file).
 * @returns the rule text plus its source and registry scope.
 */
async function effectiveRule(repoName: string, repoPath: string): Promise<GitRulesResult> {
  const key = ruleKey(repoName, repoPath)
  const registry = await readRegistry()
  const scope = registry[key]?.ruleScope
  const globalFile = join(rulesDir(), 'default.yaml')
  const repoFile = join(rulesDir(), `${key}.yaml`)
  const withScope = (rule: GitRule, source: GitRulesResult['source']): GitRulesResult =>
    ({ ...rule, source, scope: scope === undefined ? 'unset' : scope })

  if (scope === 'global') {
    const globalRule = await readRuleFile(globalFile)
    return globalRule !== null
      ? withScope(globalRule, 'global')
      : withScope(BUILTIN_RULE, 'builtin')
  }
  if (scope === 'repo') {
    const repoRule = await readRuleFile(repoFile)
    if (repoRule !== null) return withScope(repoRule, 'repo')
    const globalRule = await readRuleFile(globalFile)
    return globalRule !== null
      ? withScope(globalRule, 'global')
      : withScope(BUILTIN_RULE, 'builtin')
  }
  const repoRule = await readRuleFile(repoFile)
  if (repoRule !== null) return withScope(repoRule, 'repo')
  const globalRule = await readRuleFile(globalFile)
  if (globalRule !== null) return withScope(globalRule, 'global')
  return withScope(BUILTIN_RULE, 'builtin')
}

/**
 * Replace the four rule placeholders without regex-replacement surprises.
 * @param template - the rule text carrying `{name}` placeholders.
 * @param values - the repository values substituted into the template.
 * @returns the template with every placeholder replaced.
 */
export function renderTemplate(
  template: string,
  values: { repo_name: string; branch: string; file_list: string; staged_diff: string },
): string {
  return template
    .replaceAll('{repo_name}', values.repo_name)
    .replaceAll('{branch}', values.branch)
    .replaceAll('{file_list}', values.file_list)
    .replaceAll('{staged_diff}', values.staged_diff)
}

// ---------------------------------------------------------------------------
// audit log
// ---------------------------------------------------------------------------

/** Write operations are appended here; best-effort — a broken home never blocks git. */
let auditChain: Promise<void> = Promise.resolve()
let auditWarned = false

function audit(op: string, detail: string): void {
  const line = `[${new Date().toISOString()}] op=${op} ${detail}\n`
  auditChain = auditChain.then(async () => {
    try {
      const dir = dshHomePath('git-panel', 'logs')
      await mkdir(dir, { recursive: true })
      await appendFile(join(dir, `git-${new Date().toISOString().slice(0, 10)}.log`), line, 'utf8')
    } catch {
      if (!auditWarned) {
        auditWarned = true
        console.warn('git panel: audit log unavailable; continuing without it')
      }
    }
  })
}

// ---------------------------------------------------------------------------
// LLM bridge
// ---------------------------------------------------------------------------

/** One selectable model for the generation model picker. */
export interface GitModel {
  readonly provider: string
  readonly model: string
  readonly name: string
}

/**
 * LLM commit-message generation, provided by the plugin apply (it owns the
 * `ctx.llm` service); the service stays transport-agnostic so tests inject a stub.
 */
export interface CommitMessageBridge {
  /**
   * Stream one generation: text deltas arrive through `onText` in order, and
   * the promise resolves with the full message (the text so far when the signal aborted).
   */
  stream(params: {
    readonly system: string
    readonly user: string
    readonly signal: AbortSignal
    readonly model?: string
    readonly onText: (delta: string) => void
  }): Promise<string>
  /** The provider/model catalog for the picker. */
  listModels(): Promise<readonly GitModel[]>
}

// ---------------------------------------------------------------------------
// request plumbing
// ---------------------------------------------------------------------------

/** Resolve a requested cwd against the host's known workspace paths. */
export type GitCwdResolver = (requested: string) => string

/**
 * Default resolver: a known workspace path or any directory inside one is
 * accepted; everything else falls back to the host process cwd (the harness
 * checkout for a local `dsh web` run). The git panel discovers nested
 * repositories and worktrees and queries each one through its own path, so the
 * resolver keeps the workspace subtree rather than only the registered roots.
 * @param known - the host's current workspace paths.
 * @param fallback - host process cwd.
 * @returns the resolver.
 */
export function workspaceCwdResolver(known: readonly string[], fallback: string): GitCwdResolver {
  const roots = known.map(path => normalizeSlashes(path)).filter(path => path.length > 0)
  return (requested) => {
    if (requested.length === 0) return fallback
    const value = normalizeSlashes(requested)
    return roots.some(root => value === root || value.startsWith(`${root}/`)) ? value : fallback
  }
}

/** Normalize Windows separators so path matching is robust.
 * @param path - path to normalize.
 * @returns the path with backslashes replaced by slashes and trailing slashes trimmed.
 */
export function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Write a JSON response with the given status code. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Read the request body as JSON; rejects on parse failure. */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) { resolveBody({}); return }
      try {
        const value = JSON.parse(raw) as unknown
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          reject(new Error('git panel: JSON body must be an object'))
          return
        }
        resolveBody(value as Record<string, unknown>)
      } catch (error) {
        reject(new Error(`git panel: invalid JSON body: ${String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** A required string body field. */
function bodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`git panel: body field "${field}" must be a non-empty string`)
  }
  return value
}

/** An optional string body field. */
function bodyOptionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A required array-of-strings body field. */
function bodyPaths(body: Record<string, unknown>, field: string): string[] {
  const value = body[field]
  if (!Array.isArray(value) || value.length === 0
    || !value.every(item => typeof item === 'string' && item.length > 0)) {
    throw new Error(`git panel: body field "${field}" must be a non-empty string array`)
  }
  return value as string[]
}

/** A repository name: printable, no separators, bounded length. */
function bodyRepoName(body: Record<string, unknown>, field: string): string {
  const name = bodyString(body, field)
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || name.length > 64) {
    throw new Error('git panel: invalid repository name')
  }
  return name
}

/** Validate a repository-relative file path and resolve it against the cwd. */
function resolveRepoPath(cwd: string, filePath: string): string {
  if (filePath.includes('..') || filePath.startsWith('/') || filePath.includes('\\')) {
    throw new Error('git panel: invalid path')
  }
  const abs = resolve(join(cwd, filePath))
  const root = resolve(cwd)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error('git panel: path escapes the workspace')
  }
  return abs
}

// ---------------------------------------------------------------------------
// status parsing
// ---------------------------------------------------------------------------

/** One working-tree file in the v2 status view. */
export interface GitFile {
  /** Two-letter porcelain status (e.g. " M", "UU", "??"). */
  readonly status: string
  /** Repository-relative path. */
  readonly path: string
  /** Renamed-from path, when the status is a rename. */
  readonly renameFrom?: string | undefined
}

/** `GET /git/status` response. */
export interface GitStatusResult {
  readonly isRepo: boolean
  readonly branch: string
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  /** Active merge/rebase state, if any (drives the abort + conflict UI). */
  readonly mergeState: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null
  readonly head: string
  readonly staged: readonly GitFile[]
  readonly unstaged: readonly GitFile[]
  readonly untracked: readonly GitFile[]
  readonly conflicted: readonly GitFile[]
}

/** One commit in `GET /git/log`. */
export interface GitCommit {
  readonly hash: string
  readonly shortHash: string
  /** Parent hashes (0..2) — feeds the commit graph lanes. */
  readonly parents: readonly string[]
  readonly author: string
  readonly email: string
  /** ISO author date. */
  readonly date: string
  readonly subject: string
  readonly body: string
  /** Optional aggregate diffstat when requested. */
  readonly stat?: { files: number; insertions: number; deletions: number }
}

/** `GET /git/branches` response. */
export interface GitBranchesResult {
  readonly current: string
  readonly upstream?: string
  readonly local: readonly { name: string; current: boolean }[]
  readonly remote: readonly string[]
}

/** A per-file add/del count from `GET /git/show`. */
export interface GitShowFile {
  readonly path: string
  readonly add: number
  readonly del: number
  readonly binary: boolean
}

/**
 * Parse `git status --porcelain=v2 -b` into grouped files + branch facts.
 * @param raw - the porcelain v2 output.
 * @param renameFrom - old → new path map for staged renames (empty when none).
 * @returns the parsed status (mergeState/head are filled by the caller).
 */
function parseStatusV2(raw: string, renameFrom: Map<string, string>) {
  const branch = { head: '', upstream: '', ahead: 0, behind: 0 }
  const staged: GitFile[] = []
  const unstaged: GitFile[] = []
  const untracked: GitFile[] = []
  const conflicted: GitFile[] = []

  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ')
      if (key === 'branch.head') branch.head = rest[0] ?? ''
      else if (key === 'branch.upstream') branch.upstream = rest[0] ?? ''
      else if (key === 'branch.ahead') branch.ahead = Number(rest[0] ?? 0)
      else if (key === 'branch.behind') branch.behind = Number(rest[0] ?? 0)
      continue
    }
    const type = line[0]
    const fields = line.split(' ')
    if (type === '?') {
      untracked.push({ status: '??', path: fields[1] ?? '' })
      continue
    }
    // Modern git (2.55+) prefixes entry lines with a lead character
    // ('1' plain, '2' rename, 'u' unmerged) and marks empty XY slots with '.';
    // older git puts the two-char XY first. Accept both layouts.
    const newLayout = line.match(/^(.) ([ .MADRCUT]{2}) ([NRU]\.\.\.) /)
    const oldLayout = newLayout === null ? line.match(/^([ .MADRCUT]{2}) ([NRU]\.\.\.) /) : null
    const matched = newLayout ?? oldLayout
    if (matched === null) continue
    const rawStatus = newLayout !== null ? newLayout[2] : oldLayout?.[1]
    if (rawStatus === undefined) continue
    const status = rawStatus.replace(/\./g, ' ')
    const x = status[0] ?? ' '
    const y = status[1] ?? ' '
    const unmerged = (newLayout !== null && newLayout[1] === 'u') || x === 'U' || y === 'U'
    const pathField = fields[unmerged ? 10 : 8] ?? ''
    let path = pathField
    let source: string | undefined
    if (x === 'R' || y === 'R') {
      if (path.includes('\t')) {
        const pair = path.split('\t')
        path = pair[0] ?? ''
        source = pair[1]
      } else if (renameFrom.has(path)) {
        source = renameFrom.get(path)
      }
    }
    const file: GitFile = source !== undefined ? { status, path, renameFrom: source } : { status, path }
    if (unmerged) {
      conflicted.push(file)
    } else {
      if (x !== ' ') staged.push(file)
      if (y !== ' ') unstaged.push(file)
    }
  }

  return {
    branch: branch.head,
    upstream: branch.upstream || undefined,
    ahead: branch.ahead,
    behind: branch.behind,
    staged,
    unstaged,
    untracked,
    conflicted,
  }
}

/**
 * Recover the old names of staged renames from `git diff --cached --name-status`.
 * @param cwd - the repository directory.
 * @returns a new → old path map (empty when there are no renames).
 */
async function stagedRenameSources(cwd: string): Promise<Map<string, string>> {
  const out = await gitLenient(cwd, ['diff', '--cached', '-M', '--name-status'])
  const map = new Map<string, string>()
  for (const line of out.split('\n')) {
    const m = /^R\d+\t(.+)\t(.+)$/.exec(line)
    const [, from, to] = m ?? []
    if (from !== undefined && to !== undefined) map.set(to, from)
  }
  return map
}

/** Detect an in-progress merge/rebase/cherry-pick/revert from the git dir.
 * @param cwd - the repository directory.
 * @returns the active merge state, or null.
 */
async function detectMergeState(cwd: string): Promise<GitStatusResult['mergeState']> {
  // `--absolute-git-dir` keeps the probe inside the queried repository: the
  // relative `.git` a nested repository or worktree reports would resolve
  // against the host process cwd and read the wrong merge state.
  const gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'])).trim()
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebase'
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'revert'
  return null
}

/** The current branch name (empty outside a repo). */
async function branchName(cwd: string): Promise<string> {
  return (await gitLenient(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
}

/** The diffstat totals of one commit. */
interface CommitStat {
  readonly files: number
  readonly insertions: number
  readonly deletions: number
}

/**
 * Per-commit diffstat totals for a log window, keyed by hash.
 * @param cwd - the repository directory.
 * @param limit - number of commits in the window.
 * @param skip - the log window offset.
 * @returns a hash → totals map (commits with no changes are absent).
 */
async function parseStatBlocks(cwd: string, limit: number, skip: number): Promise<Map<string, CommitStat>> {
  const out = await gitLenient(cwd, ['log', '--all', '--topo-order', `-n${limit}`, `--skip=${skip}`, '--stat', '--pretty=format:@@%H@@'])
  const map = new Map<string, CommitStat>()
  let current: string | undefined
  for (const line of out.split('\n')) {
    const marker = /^@@([0-9a-f]+)@@/.exec(line)
    if (marker) {
      current = marker[1]
      continue
    }
    if (current === undefined) continue
    if (!/files? changed/.test(line)) continue
    const files = Number(/(\d+) file/.exec(line)?.[1] ?? 0)
    const insertions = Number(/(\d+) insertion/.exec(line)?.[1] ?? 0)
    const deletions = Number(/(\d+) deletion/.exec(line)?.[1] ?? 0)
    if (files > 0 || insertions > 0 || deletions > 0) {
      map.set(current, { files, insertions, deletions })
    }
  }
  return map
}

/** Unified diff of an untracked file (everything is an addition). */
async function diffUntracked(abs: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-git-diff-'))
  const empty = join(dir, 'empty')
  try {
    await writeFileNode(empty, '')
    // `git diff --no-index` exits 1 when the files differ; the diff itself is
    // on stdout either way, so the tolerant run is the single source.
    const out = await gitLenient(dir, ['diff', '--no-index', '--', empty, abs])
    // Re-point the diff header at the repo-relative name the panel shows.
    return out.replace(/a\/empty/g, 'a/').replace(/(\+\+\+) b\/.*$/, '$1 b/')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Image MIME by file extension (preview-only kinds). */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

/**
 * The MIME type when `path` names an image file.
 * @param path - repository-relative file path.
 * @returns the MIME type, or undefined when the extension is not an image.
 */
export function imageMimeOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  return IMAGE_MIME_BY_EXT[path.slice(dot + 1).toLowerCase()]
}

// ---------------------------------------------------------------------------
// route handler
// ---------------------------------------------------------------------------

/** In-flight LLM generations, keyed by the client-provided token. */
const activeGenerations = new Map<string, AbortController>()

/**
 * Whether a generation's abort signal fired. The read goes through a helper
 * because TypeScript narrows `signal.aborted` to its constructor-time `false`
 * literal at some of the checks in the generation flow.
 * @param controller - the generation's abort controller.
 * @returns true once `/git/generate-cancel` aborted the generation.
 */
function generationAborted(controller: AbortController): boolean {
  return controller.signal.aborted
}

/** The git panel route handler: one prefix route owning every `/git` endpoint.
 * @param resolveCwd - resolves the requested cwd against known workspaces.
 * @param req - incoming HTTP request.
 * @param res - server response.
 * @param bridge - optional LLM commit-message bridge for `/git/generate` and `/git/models`.
 */
export async function handleGitRequest(
  resolveCwd: GitCwdResolver,
  req: IncomingMessage,
  res: ServerResponse,
  bridge?: CommitMessageBridge,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://git-panel')
  const path = url.pathname
  const method = req.method ?? 'GET'
  const queryCwd = url.searchParams.get('cwd') ?? ''
  try {
    if (method === 'GET' && path === '/git/repos') {
      const cwd = resolveCwd(queryCwd)
      const refresh = url.searchParams.get('refresh') === '1'
      json(res, 200, { repos: findReposCached(cwd, refresh) })
      return
    }

    if (method === 'GET' && path === '/git/status') {
      const cwd = resolveCwd(queryCwd)
      if ((await branchName(cwd)) === '') {
        json(res, 200, { isRepo: false, branch: '', ahead: 0, behind: 0, mergeState: null, head: '', staged: [], unstaged: [], untracked: [], conflicted: [] })
        return
      }
      const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
      const raw = await git(cwd, ['status', '--porcelain=v2', '-b'])
      const parsed = parseStatusV2(raw, await stagedRenameSources(cwd))
      json(res, 200, {
        isRepo: true,
        branch: parsed.branch,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        mergeState: await detectMergeState(cwd),
        head,
        staged: parsed.staged,
        unstaged: parsed.unstaged,
        untracked: parsed.untracked,
        conflicted: parsed.conflicted,
      })
      return
    }

    if (method === 'GET' && path === '/git/log') {
      const cwd = resolveCwd(queryCwd)
      const skip = Math.max(0, Number(url.searchParams.get('skip') ?? 0) || 0)
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
      const withStat = url.searchParams.get('stat') === '1'
      const SEP = '\x1f'
      const REC = '\x1e'
      // Metadata and the diffstat come from separate calls: `--stat` interleaves
      // plain-text blocks that would corrupt the byte-framed records below.
      const metaArgs = ['log', '--all', '--topo-order', `-n${limit}`, `--skip=${skip}`]
      metaArgs.push(`--pretty=format:%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s${SEP}%b${REC}`)
      const metaOut = await git(cwd, metaArgs)
      const statByHash = withStat
        ? await parseStatBlocks(cwd, limit, skip)
        : new Map<string, CommitStat>()
      const records = metaOut.split(REC).map(rec => rec.replace(/^\r?\n+/, '')).filter(rec => rec.trim().length > 0)
      const commits: GitCommit[] = []
      for (const rec of records.slice(0, limit)) {
        const [hash, parentsRaw, author, email, date, subject, body] = rec.split(SEP)
        if (hash === undefined || hash.length === 0) continue
        const stat = statByHash.get(hash)
        commits.push({
          hash,
          shortHash: hash.slice(0, 7),
          parents: (parentsRaw ?? '').split(' ').filter(p => p.length > 0),
          author: author ?? '',
          email: email ?? '',
          date: date ?? '',
          subject: subject ?? '',
          body: (body ?? '').trim(),
          ...(stat !== undefined ? { stat } : {}),
        })
      }
      json(res, 200, { commits, hasMore: commits.length === limit })
      return
    }

    if (method === 'GET' && path === '/git/branches') {
      const cwd = resolveCwd(queryCwd)
      const current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      const upstream = (await gitLenient(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim()
      const localOut = await git(cwd, ['branch', '--list', '--format=%(refname:short)%00%(HEAD)'])
      const local = localOut.split('\n').filter(l => l.length > 0)
        .map((l) => { const [name, head] = l.split('\x00'); return { name, current: head === '*' } })
      const remoteOut = await git(cwd, ['branch', '-r', '--list', '--format=%(refname:short)'])
      const remote = remoteOut.split('\n').filter(l => l.length > 0 && !l.includes('->'))
      json(res, 200, { current, upstream: upstream || undefined, local, remote })
      return
    }

    if (method === 'GET' && path === '/git/show') {
      const cwd = resolveCwd(queryCwd)
      const hash = url.searchParams.get('hash') ?? ''
      if (hash.length === 0) throw new Error('git panel: /git/show needs a hash')
      const message = (await git(cwd, ['show', '-s', '--format=%B', hash])).trim()
      const numstat = await gitLenient(cwd, ['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', hash])
      const files: GitShowFile[] = numstat.split('\n').filter(l => l.length > 0).map((l) => {
        const [add, del, ...pathParts] = l.split('\t')
        const binary = add === '-' && del === '-'
        return {
          path: pathParts.join('\t'),
          add: binary ? 0 : Number(add ?? 0),
          del: binary ? 0 : Number(del ?? 0),
          binary,
        }
      })
      json(res, 200, { message, files })
      return
    }

    if (method === 'GET' && path === '/git/blob') {
      const cwd = resolveCwd(queryCwd)
      const filePath = url.searchParams.get('path') ?? ''
      if (filePath.length === 0) throw new Error('git panel: /git/blob needs a path')
      const source = url.searchParams.get('source') ?? ''
      if (!['head', 'index', 'worktree'].includes(source)) {
        throw new Error('git panel: /git/blob source must be head, index, or worktree')
      }
      let buffer: Buffer
      if (source === 'worktree') {
        const abs = resolveRepoPath(cwd, filePath)
        try {
          buffer = await readFile(abs)
        } catch {
          throw new Error('git panel: file is not in the worktree')
        }
      } else {
        buffer = await gitShowBuffer(cwd, source === 'head' ? `HEAD:${filePath}` : `:${filePath}`)
      }
      const mime = imageMimeOf(filePath) ?? 'application/octet-stream'
      json(res, 200, {
        mime,
        size: buffer.length,
        dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
      })
      return
    }

    if (method === 'GET' && path === '/git/models') {
      if (bridge === undefined) throw new Error('git panel: no LLM service is available')
      json(res, 200, { models: await bridge.listModels() })
      return
    }

    if (method === 'GET' && path === '/git/rules') {
      const cwd = resolveCwd(queryCwd)
      const repo = url.searchParams.get('repo') ?? ''
      if (repo.length === 0) throw new Error('git panel: /git/rules needs a repo name')
      if (repo.includes('/') || repo.includes('\\')) throw new Error('git panel: invalid repository name')
      const rule = await effectiveRule(repo, cwd)
      json(res, 200, rule)
      return
    }

    if (method === 'POST' && path === '/git/stage') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      const paths = bodyPaths(body, 'paths')
      await addPaths(cwd, paths)
      audit('stage', `ok=1 repo=${basename(cwd)} files=${paths.length}`)
      json(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/git/unstage') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      const paths = bodyPaths(body, 'paths')
      await resetPaths(cwd, paths)
      audit('unstage', `ok=1 repo=${basename(cwd)} files=${paths.length}`)
      json(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/git/discard') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      const paths = bodyPaths(body, 'paths')
      const staged = body['staged'] === true
      if (staged) {
        await gitRun({ cwd, args: ['restore', '--staged', '--', ...paths] })
      }
      await gitRun({ cwd, args: ['restore', '--worktree', '--', ...paths] })
      audit('discard', `ok=1 repo=${basename(cwd)} files=${paths.length} staged=${staged ? 1 : 0}`)
      json(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/git/clean') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      const paths = bodyPaths(body, 'paths')
      // `git clean` has no pathspec-from-file: chunk the argv to stay under limits.
      for (let i = 0; i < paths.length; i += 200) {
        await gitRun({ cwd, args: ['clean', '-f', '--', ...paths.slice(i, i + 200)] })
      }
      audit('clean', `ok=1 repo=${basename(cwd)} files=${paths.length}`)
      json(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/git/diff') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      const filePath = bodyString(body, 'path')
      const abs = resolveRepoPath(cwd, filePath)
      let diff: string
      if (body['untracked'] === true) {
        diff = await diffUntracked(abs)
      } else if (body['staged'] === true) {
        diff = await git(cwd, ['diff', '--cached', '--', filePath])
      } else {
        diff = await git(cwd, ['diff', '--', filePath])
      }
      json(res, 200, { diff })
      return
    }

    if (method === 'POST' && path === '/git/commit') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      const message = bodyString(body, 'message')
      if (message.length > 4_096) throw new Error('git panel: commit message too long')
      const raw = await git(cwd, ['status', '--porcelain=v2', '-b'])
      // Porcelain v2: unmerged entries are the lines starting with "u ".
      const conflictedCount = raw.split('\n').filter(l => l.startsWith('u ')).length
      if (conflictedCount > 0) {
        throw new Error(`git panel: ${conflictedCount} file(s) still have unmerged changes; resolve them first`)
      }
      // Message through stdin: immune to Windows command-line length and quoting.
      await gitRun({ cwd, args: ['commit', '-F', '-'], stdin: `${message}\n` })
      const hash = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
      audit('commit', `ok=1 repo=${basename(cwd)} hash=${hash.slice(0, 7)}`)
      json(res, 200, { ok: true, hash })
      return
    }

    if (method === 'POST' && path === '/git/undo-commit') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      const hash = bodyString(body, 'hash')
      const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
      if (head !== hash) {
        throw new Error('git panel: HEAD moved since the failed push; refusing to undo a different commit')
      }
      const count = Number((await git(cwd, ['rev-list', '--count', 'HEAD'])).trim())
      if (count <= 1) throw new Error('git panel: the repository only has its first commit; nothing to undo')
      await gitRun({ cwd, args: ['reset', '--soft', 'HEAD~1'] })
      audit('undo-commit', `ok=1 repo=${basename(cwd)} hash=${hash.slice(0, 7)}`)
      json(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/git/push') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      try {
        await gitRun({ cwd, args: ['push'], timeoutMs: 120_000 })
        audit('push', `ok=1 repo=${basename(cwd)}`)
        json(res, 200, { ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // "no upstream" is a distinct outcome the panel turns into guidance.
        const noUpstream = /no upstream branch|没有上游|未设置上游/i.test(message)
        audit('push', `ok=0 repo=${basename(cwd)} error=${message.slice(0, 200)}`)
        json(res, 500, { error: message, ...(noUpstream ? { noUpstream: true } : {}) })
        return
      }
      return
    }

    if (method === 'POST' && path === '/git/pull') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      if ((await detectMergeState(cwd)) !== null) {
        throw new Error('git panel: a merge or rebase is in progress; resolve it or abort before pulling')
      }
      await gitRun({ cwd, args: ['fetch', '--all', '--prune'], timeoutMs: 120_000 })
      const upstream = (await gitLenient(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim()
      if (upstream.length > 0) {
        await gitRun({ cwd, args: ['merge', '--no-edit', '@{u}'], timeoutMs: 120_000 })
      }
      audit('pull', `ok=1 repo=${basename(cwd)} upstream=${upstream.length > 0 ? 1 : 0}`)
      json(res, 200, { ok: true, ...(upstream.length === 0 ? { fetchedOnly: true } : {}) })
      return
    }

    if (method === 'POST' && path === '/git/switch') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      const branch = bodyString(body, 'branch')
      if (branch.includes('/') || branch.includes('\\') || branch.includes('\0') || branch.length > 128) {
        throw new Error('git panel: invalid branch name')
      }
      if (body['create'] === true) {
        await gitRun({ cwd, args: ['switch', '-c', branch] })
      } else {
        await gitRun({ cwd, args: ['switch', branch] })
      }
      audit('switch', `ok=1 repo=${basename(cwd)} branch=${branch} create=${body['create'] === true ? 1 : 0}`)
      json(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/git/stash') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      const op = bodyString(body, 'op')
      if (op === 'list') {
        const out = await gitLenient(cwd, ['stash', 'list', '--format=%gd\t%s'])
        const entries = out.split('\n').filter(l => l.length > 0)
          .map((l) => { const [name, message] = l.split('\t'); return { name, message: message ?? '' } })
        json(res, 200, { entries })
      } else if (op === 'push') {
        const message = bodyOptionalString(body, 'message')
        await gitRun({ cwd, args: ['stash', 'push', ...(message ? ['-m', message] : [])] })
        audit('stash', `ok=1 repo=${basename(cwd)} op=push`)
        json(res, 200, { ok: true })
      } else if (op === 'pop') {
        await gitRun({ cwd, args: ['stash', 'pop'] })
        audit('stash', `ok=1 repo=${basename(cwd)} op=pop`)
        json(res, 200, { ok: true })
      } else {
        throw new Error('git panel: stash op must be list, push, or pop')
      }
      return
    }

    if (method === 'POST' && path === '/git/merge-abort') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      await gitRun({ cwd, args: ['merge', '--abort'] })
      audit('merge-abort', `ok=1 repo=${basename(cwd)}`)
      json(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/git/merge-complete') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      await gitRun({ cwd, args: ['commit', '--no-edit'] })
      const hash = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
      audit('merge-complete', `ok=1 repo=${basename(cwd)} hash=${hash.slice(0, 7)}`)
      json(res, 200, { ok: true, hash })
      return
    }

    if (method === 'POST' && path === '/git/reset') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      const mode = bodyString(body, 'mode')
      if (!['soft', 'mixed', 'hard'].includes(mode)) {
        throw new Error('git panel: reset mode must be soft, mixed, or hard')
      }
      await gitRun({ cwd, args: ['reset', `--${mode}`, 'HEAD'] })
      audit('reset', `ok=1 repo=${basename(cwd)} mode=${mode}`)
      json(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/git/rules-save') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      const repo = bodyRepoName(body, 'repo')
      const scope = bodyString(body, 'scope')
      if (scope !== 'global' && scope !== 'repo') {
        throw new Error('git panel: rules-save scope must be global or repo')
      }
      const systemPrompt = bodyString(body, 'systemPrompt')
      const userContext = bodyOptionalString(body, 'userContext') ?? BUILTIN_RULE.userContext
      await mkdir(rulesDir(), { recursive: true })
      const file = scope === 'global'
        ? join(rulesDir(), 'default.yaml')
        : join(rulesDir(), `${ruleKey(repo, cwd)}.yaml`)
      await writeFile(file, yaml.dump({ system_prompt: systemPrompt, user_context: userContext }), 'utf8')
      await writeRegistryEntry(ruleKey(repo, cwd), { path: normalizeSlashes(resolve(cwd)), ruleScope: scope })
      audit('rules-save', `ok=1 repo=${repo} scope=${scope}`)
      json(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/git/rules-reset') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      const repo = bodyRepoName(body, 'repo')
      const scope = bodyString(body, 'scope')
      if (scope !== 'global' && scope !== 'repo') {
        throw new Error('git panel: rules-reset scope must be global or repo')
      }
      const key = ruleKey(repo, cwd)
      const file = scope === 'global'
        ? join(rulesDir(), 'default.yaml')
        : join(rulesDir(), `${key}.yaml`)
      try {
        await readFile(file)
        await rm(file)
      } catch {
        // Absent is the reset end-state.
      }
      if (scope === 'repo') await deleteRegistryEntry(key)
      audit('rules-reset', `ok=1 repo=${repo} scope=${scope}`)
      json(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/git/generate') {
      const body = await readJson(req)
      const cwd = resolveCwd(bodyString(body, 'cwd'))
      if (bridge === undefined) throw new Error('git panel: no LLM service is available')
      const token = bodyString(body, 'token')
      const controller = new AbortController()
      activeGenerations.set(token, controller)
      // NDJSON stream: the client renders text deltas as they arrive and keeps
      // the partial text when the generation is stopped.
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
      })
      const send = (obj: unknown): void => {
        if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`)
      }
      try {
        const staged = await gitLenient(cwd, ['diff', '--cached'])
        if (generationAborted(controller)) {
          send({ t: 'stop' })
          return
        }
        if (staged.trim().length === 0) {
          throw new Error('git panel: nothing staged to generate a message from')
        }
        const repoName = basename(cwd)
        const branch = await branchName(cwd)
        const fileList = (await git(cwd, ['diff', '--cached', '--name-only'])).split('\n').filter(l => l.length > 0)
        const rule = await effectiveRule(repoName, cwd)
        const diff = staged.length > MAX_STAGED_DIFF_BYTES
          ? `${staged.slice(0, MAX_STAGED_DIFF_BYTES)}\n... (diff truncated)`
          : staged
        const values = { repo_name: repoName, branch, file_list: fileList.join('\n'), staged_diff: diff }
        const model = bodyOptionalString(body, 'model')
        const message = await bridge.stream({
          system: renderTemplate(rule.systemPrompt, values),
          user: renderTemplate(rule.userContext, values),
          signal: controller.signal,
          onText: (delta) => { send({ t: 'text', x: delta }) },
          ...(model !== undefined ? { model } : {}),
        })
        if (generationAborted(controller)) {
          send({ t: 'stop' })
          audit('generate', `ok=0 repo=${repoName} aborted=1`)
        } else {
          send({ t: 'done', m: message })
          audit('generate', `ok=1 repo=${repoName}`)
        }
      } catch (error) {
        if (generationAborted(controller)) {
          send({ t: 'stop' })
        } else {
          send({ t: 'err', e: error instanceof Error ? error.message : String(error) })
          audit('generate', `ok=0 repo=${basename(cwd)}`)
        }
      } finally {
        activeGenerations.delete(token)
        if (!res.writableEnded) res.end()
      }
      return
    }

    if (method === 'POST' && path === '/git/generate-cancel') {
      const body = await readJson(req)
      const token = bodyString(body, 'token')
      const controller = activeGenerations.get(token)
      if (controller !== undefined) controller.abort()
      json(res, 200, { ok: true })
      return
    }

    json(res, 404, { error: `git panel: unknown route ${method} ${path}` })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!res.headersSent) {
      json(res, 500, { error: message })
    } else if (!res.writableEnded) {
      res.end()
    }
  }
}
