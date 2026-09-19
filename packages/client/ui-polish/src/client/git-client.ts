// Shared git-panel HTTP client: typed fetch helpers for the /git/* routes.
// Carries the current workspace path (or a discovered repository path) as the
// `cwd` parameter, so switching workspaces switches the repository set.

/** One working-tree file from `/git/status`. */
export interface GitFile {
  status: string
  path: string
  renameFrom?: string
}

/** `/git/status` response. */
export interface GitStatus {
  isRepo: boolean
  branch: string
  upstream?: string
  ahead: number
  behind: number
  mergeState: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null
  head: string
  staged: readonly GitFile[]
  unstaged: readonly GitFile[]
  untracked: readonly GitFile[]
  conflicted: readonly GitFile[]
}

/** One discovered repository from `/git/repos`. */
export interface GitRepo {
  path: string
  name: string
  isWorktree: boolean
}

/** One commit from `/git/log`. */
export interface GitCommit {
  hash: string
  shortHash: string
  parents: readonly string[]
  author: string
  email: string
  date: string
  subject: string
  body: string
  stat?: { files: number; insertions: number; deletions: number }
}

/** `/git/branches` response. */
export interface GitBranches {
  current: string
  upstream?: string
  local: readonly { name: string; current: boolean }[]
  remote: readonly string[]
}

/** `/git/show` response. */
export interface GitShow {
  message: string
  files: readonly { path: string; add: number; del: number; binary: boolean }[]
}

/** One file version from `/git/blob` (image diff preview). */
export interface GitBlob {
  mime: string
  size: number
  dataUrl: string
}

/** One selectable generation model from `/git/models`. */
export interface GitModel {
  provider: string
  model: string
  name: string
}

/** A commit rule plus the file it was read from. */
export interface GitRules {
  systemPrompt: string
  userContext: string
  source: 'repo' | 'global' | 'builtin'
  scope: 'global' | 'repo' | 'unset'
}

/** One stash entry. */
export interface GitStashEntry {
  name: string
  message: string
}

/**
 * Query-encode the cwd into a `/git` URL.
 * @param path - route path (e.g. `/git/status`).
 * @param cwd - workspace or repository directory carried as the `cwd` query parameter.
 * @param params - additional query parameters.
 * @returns the URL with the query string attached.
 */
export function gitUrl(path: string, cwd: string, params?: Record<string, string>): string {
  const search = new URLSearchParams({ cwd })
  for (const [key, value] of Object.entries(params ?? {})) search.set(key, value)
  return `${path}?${search.toString()}`
}

/** GET with query params (cwd always present).
 * @param path - route path.
 * @param cwd - workspace or repository directory.
 * @param params - extra query params.
 * @returns the parsed JSON payload.
 * @throws {Error} when the response is not ok, with the body `error` message when present.
 */
export async function gitGet<T>(path: string, cwd: string, params?: Record<string, string>): Promise<T> {
  const response = await fetch(gitUrl(path, cwd, params))
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `git panel: HTTP ${response.status}`)
  }
  return payload as unknown as T
}

/** POST a JSON body (cwd merged).
 * @param path - route path.
 * @param cwd - workspace or repository directory.
 * @param body - the JSON body.
 * @returns the parsed JSON payload.
 */
export async function gitPost<T>(path: string, cwd: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, cwd }),
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `git panel: HTTP ${response.status}`)
  }
  return payload as unknown as T
}

/**
 * Stream one commit-message generation from `/git/generate` (NDJSON):
 * text deltas arrive through `onText` in order; resolves with the full message
 * on `done`, resolves with the text accumulated so far on `stop`, and rejects
 * on `err` (or a transport failure).
 * @param cwd - the repository directory.
 * @param token - client token for the cancel route.
 * @param onText - called with each text delta as it arrives.
 * @param model - optional model hint.
 * @returns the full generated message (or the partial text when stopped).
 */
export async function gitGenerate(
  cwd: string,
  token: string,
  onText: (delta: string) => void,
  model?: string,
): Promise<string> {
  const response = await fetch('/git/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, token, ...(model !== undefined ? { model } : {}) }),
  })
  if (!response.ok || response.body === null) {
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    throw new Error(typeof payload.error === 'string' ? payload.error : `git panel: HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let collected = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length === 0) continue
      const event = JSON.parse(line) as { t: string; x?: string; m?: string; e?: string }
      if (event.t === 'text' && typeof event.x === 'string') {
        collected += event.x
        onText(event.x)
      } else if (event.t === 'done') {
        return event.m ?? collected
      } else if (event.t === 'stop') {
        return collected
      } else if (event.t === 'err') {
        throw new Error(event.e ?? 'git panel: generation failed')
      }
    }
  }
  throw new Error('git panel: generation stream closed without a result')
}

/** The fetch surface used by the panel (kept as one object for test seams). */
export const gitApi = {
  repos: (cwd: string, refresh: boolean): Promise<{ repos: readonly GitRepo[] }> =>
    gitGet('/git/repos', cwd, { ...(refresh ? { refresh: '1' } : {}) }),
  status: (cwd: string): Promise<GitStatus> => gitGet<GitStatus>('/git/status', cwd),
  log: (cwd: string, skip: number, limit: number): Promise<{ commits: readonly GitCommit[]; hasMore: boolean }> =>
    gitGet('/git/log', cwd, { skip: String(skip), limit: String(limit), stat: '1' }),
  branches: (cwd: string): Promise<GitBranches> => gitGet<GitBranches>('/git/branches', cwd),
  show: (cwd: string, hash: string): Promise<GitShow> => gitGet<GitShow>('/git/show', cwd, { hash }),
  blob: (cwd: string, path: string, source: 'head' | 'index' | 'worktree'): Promise<GitBlob> =>
    gitGet<GitBlob>('/git/blob', cwd, { path, source }),
  models: (): Promise<{ models: readonly GitModel[] }> => gitGet('/git/models', ''),
  rules: (cwd: string, repo: string): Promise<GitRules> => gitGet<GitRules>('/git/rules', cwd, { repo }),
  stage: (cwd: string, paths: readonly string[]): Promise<{ ok: boolean }> => gitPost('/git/stage', cwd, { paths: [...paths] }),
  unstage: (cwd: string, paths: readonly string[]): Promise<{ ok: boolean }> => gitPost('/git/unstage', cwd, { paths: [...paths] }),
  discard: (cwd: string, paths: readonly string[], staged: boolean): Promise<{ ok: boolean }> => gitPost('/git/discard', cwd, { paths: [...paths], staged }),
  clean: (cwd: string, paths: readonly string[]): Promise<{ ok: boolean }> => gitPost('/git/clean', cwd, { paths: [...paths] }),
  diff: (cwd: string, path: string, staged: boolean, untracked: boolean): Promise<{ diff: string }> =>
    gitPost('/git/diff', cwd, { path, staged, untracked }),
  commit: (cwd: string, message: string): Promise<{ ok: boolean; hash: string }> => gitPost('/git/commit', cwd, { message }),
  undoCommit: (cwd: string, hash: string): Promise<{ ok: boolean }> => gitPost('/git/undo-commit', cwd, { hash }),
  push: (cwd: string): Promise<{ ok: boolean }> => gitPost('/git/push', cwd),
  pull: (cwd: string): Promise<{ ok: boolean; fetchedOnly?: boolean }> => gitPost('/git/pull', cwd),
  switch: (cwd: string, branch: string, create: boolean): Promise<{ ok: boolean }> => gitPost('/git/switch', cwd, { branch, create }),
  stashList: (cwd: string): Promise<{ entries: readonly GitStashEntry[] }> => gitPost('/git/stash', cwd, { op: 'list' }),
  stashPush: (cwd: string, message?: string): Promise<{ ok: boolean }> => gitPost('/git/stash', cwd, { op: 'push', ...(message ? { message } : {}) }),
  stashPop: (cwd: string): Promise<{ ok: boolean }> => gitPost('/git/stash', cwd, { op: 'pop' }),
  mergeAbort: (cwd: string): Promise<{ ok: boolean }> => gitPost('/git/merge-abort', cwd),
  mergeComplete: (cwd: string): Promise<{ ok: boolean; hash: string }> => gitPost('/git/merge-complete', cwd),
  reset: (cwd: string, mode: 'soft' | 'mixed' | 'hard'): Promise<{ ok: boolean }> => gitPost('/git/reset', cwd, { mode }),
  rulesSave: (cwd: string, repo: string, scope: 'global' | 'repo', systemPrompt: string, userContext: string): Promise<{ ok: boolean }> =>
    gitPost('/git/rules-save', cwd, { repo, scope, systemPrompt, userContext }),
  rulesReset: (cwd: string, repo: string, scope: 'global' | 'repo'): Promise<{ ok: boolean }> =>
    gitPost('/git/rules-reset', cwd, { repo, scope }),
  generate: (cwd: string, token: string, onText: (delta: string) => void, model?: string): Promise<string> =>
    gitGenerate(cwd, token, onText, model),
  generateCancel: (token: string): Promise<{ ok: boolean }> => gitPost('/git/generate-cancel', '', { token }),
}
