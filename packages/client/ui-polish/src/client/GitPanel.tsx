// Git panel: a `conversation.view` tab showing the git repositories under the
// workspace the browser is viewing. VS Code source-control layout per repo:
// a branch header with pull/refresh/more actions, a commit box with LLM
// message generation under configurable rules, working-tree groups
// (conflicts / staged / changes / untracked) with per-file stage/unstage/
// discard and a two-column diff drawer (images side by side with fullscreen),
// and a collapsible commit history with an SVG lane graph, hover details,
// and infinite scroll. The host exposes `/git/*` routes registered by the
// node half; each card is a plain fetch client carrying its repository path.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: pulls the session/workspace slot hooks (useSession/useWorkspaces).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { gitApi, type GitBranches, type GitBlob, type GitCommit, type GitFile, type GitModel, type GitRepo, type GitRules, type GitStatus } from './git-client.ts'
import css from './GitPanel.module.css'

/** Full component props: conversation view share + the ui-polish locale seat. */
export type GitPanelProps = PropsRuntime<'conversation.view'> & PropsLocale<'ui-polish'>

type TFunc = TranslateNS<'ui-polish'>

/** The workspace path owning the current session, if any. */
function workspacePathOf(sessionId: string | undefined, items: readonly WorkspaceView[]): string | undefined {
  if (sessionId === undefined) return undefined
  return items.find(item => item.sessionIds.includes(sessionId as never))?.path
}

/** Repository-relative basename (last path segment). */
function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

/** Directory portion of a repository-relative path (without the name). */
function dirname(path: string): string {
  const parts = path.split('/')
  return parts.length <= 1 ? '' : parts.slice(0, -1).join('/')
}

/** ISO date → short local label. */
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

/** Image extensions the diff drawer renders as pictures. */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'])

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot >= 0 && IMAGE_EXT.has(path.slice(dot + 1).toLowerCase())
}

// --- Unified diff parsing ---------------------------------------------------

/** One visual diff row for the two-column renderer. */
interface DiffRow {
  kind: 'hunk' | 'ctx' | 'del' | 'add' | 'meta'
  text: string
  oldNo?: number
  newNo?: number
}

/**
 * Parse a unified diff into two-column visual rows. Hunk headers carry the
 * line counters; `-`/`+`/context lines advance them. Conflict markers get a
 * distinct row kind so the drawer can highlight them.
 * @param text - the `git diff` output.
 * @returns the ordered visual rows.
 */
function isConflictMarker(line: string): boolean {
  return line.includes('<<<<<<<') || line.includes('=======') || line.includes('>>>>>>>')
}

function parseUnifiedDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldCur = 0
  let newCur = 0
  for (const raw of text.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk !== null) {
      oldCur = Number(hunk[1])
      newCur = Number(hunk[2])
      rows.push({ kind: 'hunk', text: raw })
      continue
    }
    if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      continue
    }
    if (raw.startsWith('-')) {
      rows.push(isConflictMarker(raw)
        ? { kind: 'meta', text: raw.slice(1), oldNo: oldCur }
        : { kind: 'del', text: raw.slice(1), oldNo: oldCur })
      oldCur += 1
    } else if (raw.startsWith('+')) {
      rows.push(isConflictMarker(raw)
        ? { kind: 'meta', text: raw.slice(1), newNo: newCur }
        : { kind: 'add', text: raw.slice(1), newNo: newCur })
      newCur += 1
    } else {
      rows.push({
        kind: isConflictMarker(raw) ? 'meta' : 'ctx',
        text: raw.startsWith(' ') ? raw.slice(1) : raw,
        oldNo: oldCur,
        newNo: newCur,
      })
      oldCur += 1
      newCur += 1
    }
  }
  return rows
}

/** Add/del counts for a file from its unified diff. */
function diffCounts(rows: readonly DiffRow[]): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const row of rows) {
    if (row.kind === 'add') add += 1
    else if (row.kind === 'del') del += 1
  }
  return { add, del }
}

// --- Commit graph layout ----------------------------------------------------

/** One positioned commit for the SVG graph. */
interface GraphNode {
  hash: string
  lane: number
  row: number
}

/**
 * Assign lanes + rows for the commit graph. A commit takes its (leftmost)
 * parent's lane when free, else the leftmost free lane, else a new lane.
 * @param commits - commits in log order (newest first).
 * @returns one node per commit.
 */
function layoutGraph(commits: readonly GitCommit[]): GraphNode[] {
  const laneByHash = new Map<string, number>()
  const nodes: GraphNode[] = []
  const MAX_LANES = 8
  for (let i = 0; i < commits.length; i += 1) {
    const commit = commits[i] as GitCommit
    const occupied = new Set(nodes.filter(n => n.row === i).map(n => n.lane))
    let lane: number | undefined
    for (const parent of commit.parents) {
      const pl = laneByHash.get(parent)
      if (pl !== undefined && pl < MAX_LANES && !occupied.has(pl)) {
        lane = pl
        break
      }
    }
    if (lane === undefined) {
      for (let l = 0; l < MAX_LANES; l += 1) {
        if (!occupied.has(l)) {
          lane = l
          break
        }
      }
    }
    if (lane === undefined) lane = i % MAX_LANES
    laneByHash.set(commit.hash, lane)
    nodes.push({ hash: commit.hash, lane, row: i })
  }
  return nodes
}

// --- Untracked directory tree ------------------------------------------------

/** One node of the two-level untracked directory tree. */
interface DirNode {
  dir: string
  files: readonly GitFile[]
  subdirs: readonly string[]
}

/**
 * Group untracked files into a two-level directory tree (root files first,
 * then directories with their files and nested directory names).
 * @param files - the untracked file list.
 * @returns the tree nodes (directories only).
 */
function buildUntrackedTree(files: readonly GitFile[]): DirNode[] {
  const byDir = new Map<string, GitFile[]>()
  for (const file of files) {
    const dir = dirname(file.path)
    const list = byDir.get(dir) ?? []
    list.push(file)
    byDir.set(dir, list)
  }
  const nodes: DirNode[] = []
  for (const [dir, dirFiles] of byDir) {
    if (dir === '') continue
    const slash = dir.lastIndexOf('/')
    const top = slash < 0 ? dir : dir.slice(0, slash)
    const rest = slash < 0 ? '' : dir.slice(slash + 1)
    let node = nodes.find(n => n.dir === top)
    if (node === undefined) {
      node = { dir: top, files: [], subdirs: [] }
      nodes.push(node)
    }
    if (rest === '') {
      node.files = [...node.files, ...dirFiles]
    } else if (!node.subdirs.includes(rest)) {
      node.subdirs = [...node.subdirs, rest]
    }
  }
  return nodes.sort((a, b) => a.dir.localeCompare(b.dir))
}

// --- Panel ------------------------------------------------------------------

/**
 * Render the git panel as a conversation view tab: one card per repository
 * discovered under the current workspace.
 * @param props - composed slot props.
 * @returns the panel.
 */
export function GitPanel({ useSession, useWorkspaces, t }: GitPanelProps) {
  const sessionId = useSession(s => s.sessionId)
  const workspaceItems = useWorkspaces(s => s.items)
  const cwd = useMemo(
    () => workspacePathOf(sessionId, workspaceItems),
    [sessionId, workspaceItems],
  )
  const [repos, setRepos] = useState<readonly GitRepo[] | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [models, setModels] = useState<readonly GitModel[] | null>(null)

  useEffect(() => {
    if (cwd === undefined) return
    let live = true
    setRepos(null)
    setScanError(null)
    void gitApi.repos(cwd, refreshTick > 0)
      .then((result) => { if (live) setRepos(result.repos) })
      .catch((error: unknown) => { if (live) setScanError(error instanceof Error ? error.message : String(error)) })
    return () => { live = false }
  }, [cwd, refreshTick])

  // The model catalog is fetched once per panel lifetime (it is topology,
  // not repo state) and cached for every card's model picker.
  useEffect(() => {
    let live = true
    void gitApi.models()
      .then((result) => { if (live) setModels(result.models) })
      .catch(() => { if (live) setModels([]) })
    return () => { live = false }
  }, [])

  if (cwd === undefined) {
    return <div className={css.empty}>{t('git.noWorkspace')}</div>
  }
  if (scanError !== null) {
    return <div className={css.error}>{scanError}</div>
  }
  if (repos === null) {
    return <div className={css.empty}>…</div>
  }
  if (repos.length === 0) {
    return (
      <div className={css.view}>
        <div className={css.workspaceHeader}>
          <span className={css.repoTitle} title={cwd}>{basename(cwd.replace(/\\/g, '/'))}</span>
          <button className={css.iconBtn} title={t('git.refresh')} onClick={() => { setRefreshTick(v => v + 1) }}>⟳</button>
        </div>
        <div className={css.empty}>{t('git.noRepo')}</div>
      </div>
    )
  }
  const rootIsRepo = repos.find(r => r.path === cwd.replace(/\\/g, '/')) !== undefined

  return (
    <div className={css.view}>
      <div className={css.workspaceHeader}>
        <span className={css.repoTitle} title={cwd}>{basename(cwd.replace(/\\/g, '/'))}</span>
        <span className={css.repoCount}>{t('git.repoCount', { n: repos.length })}</span>
        <button className={css.iconBtn} title={t('git.refresh')} onClick={() => { setRefreshTick(v => v + 1) }}>⟳</button>
      </div>
      {repos.map(repo => (
        <RepoCard
          key={repo.path}
          repo={repo}
          refreshTick={refreshTick}
          models={models ?? []}
          isRoot={rootIsRepo && repo.path === cwd.replace(/\\/g, '/')}
          t={t}
        />
      ))}
    </div>
  )
}

// --- Repo card ---------------------------------------------------------------

/** One generation state for the commit-box button. */
type GenState = 'idle' | 'running' | 'stopping'

/** Confirmable destructive actions. */
type ConfirmKind = 'discard' | 'reset-hard' | 'clean' | 'merge-abort'

/** The image pair a side-by-side diff drawer shows. */
interface ImageDiffState {
  readonly file: GitFile
  readonly oldUrl: string | null
  readonly newUrl: string | null
  readonly oldError: string | null
}

interface RepoCardProps {
  repo: GitRepo
  refreshTick: number
  models: readonly GitModel[]
  isRoot: boolean
  t: TFunc
}

/**
 * The full panel for one repository: header, commit box, working-tree groups,
 * history, and its modals. All per-repo state lives here.
 */
function RepoCard({ repo, refreshTick, models, isRoot, t }: RepoCardProps) {
  const cwd = repo.path
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<GitBranches | null>(null)
  const [commits, setCommits] = useState<readonly GitCommit[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [genState, setGenState] = useState<GenState>('idle')
  const [genElapsed, setGenElapsed] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const [diff, setDiff] = useState<{ file: GitFile; rows: readonly DiffRow[]; staged: boolean } | null>(null)
  const [imageDiff, setImageDiff] = useState<ImageDiffState | null>(null)
  const [imageFull, setImageFull] = useState<GitBlob | null>(null)
  const [imageFullWhich, setImageFullWhich] = useState<'old' | 'new'>('new')
  const [wrap, setWrap] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [rulesMenuOpen, setRulesMenuOpen] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null)
  const [confirmPaths, setConfirmPaths] = useState<readonly string[]>([])
  const [pushFail, setPushFail] = useState<{ message: string; noUpstream: boolean } | null>(null)
  const [lastHash, setLastHash] = useState<string | null>(null)
  const [hover, setHover] = useState<{ commit: GitCommit; x: number; y: number } | null>(null)
  const [stashEntries, setStashEntries] = useState<readonly { name: string; message: string }[]>([])
  const [rules, setRules] = useState<GitRules | null>(null)
  const [ruleEditorOpen, setRuleEditorOpen] = useState(false)
  const [modelModalOpen, setModelModalOpen] = useState(false)
  const [genModel, setGenModel] = useState<string | undefined>(() => {
    try { return window.localStorage.getItem('dsh-git-gen-model') ?? undefined } catch { return undefined }
  })

  const generateToken = useRef(0)
  const sentinelRef = useRef<HTMLLIElement | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  const originalMessage = useRef('')

  const flash = useCallback((text: string) => {
    setNotice(text)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => { setNotice(null) }, 2500)
  }, [])

  const loadPage = useCallback(async (skip: number, replace: boolean) => {
    const { commits: page, hasMore: more } = await gitApi.log(cwd, skip, 100)
    setCommits(prev => (replace ? [...page] : [...prev, ...page]))
    setHasMore(more)
  }, [cwd])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [st, br, first] = await Promise.all([
        gitApi.status(cwd),
        gitApi.branches(cwd),
        gitApi.log(cwd, 0, 100),
      ])
      setStatus(st)
      setBranches(br)
      setCommits([...first.commits])
      setHasMore(first.hasMore)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshTick])

  // Generation elapsed-seconds ticker (500 ms while running).
  useEffect(() => {
    if (genState !== 'running') return
    const started = Date.now()
    const timer = window.setInterval(() => { setGenElapsed(Math.floor((Date.now() - started) / 1000)) }, 500)
    return () => { window.clearInterval(timer) }
  }, [genState])

  const loadMore = useCallback(() => {
    if (!hasMore) return
    void loadPage(commits.length, false)
  }, [hasMore, commits.length, loadPage])

  useEffect(() => {
    const el = sentinelRef.current
    if (el === null || !historyOpen) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) loadMore()
    }, { rootMargin: '200px' })
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [historyOpen, loadMore])

  // --- file actions ---------------------------------------------------------

  const runAction = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await action()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [refresh])

  const stage = useCallback((paths: readonly string[]) => {
    void runAction(t('git.staging'), () => gitApi.stage(cwd, paths))
  }, [cwd, runAction, t])

  const unstage = useCallback((paths: readonly string[]) => {
    void runAction(t('git.unstaging'), () => gitApi.unstage(cwd, paths))
  }, [cwd, runAction, t])

  const confirmDiscard = useCallback((paths: readonly string[]) => {
    setConfirmPaths(paths)
    setConfirm('discard')
  }, [])

  const doDiscard = useCallback(async () => {
    const staged = status?.staged.some(f => confirmPaths.includes(f.path)) ?? false
    await runAction(t('git.discard'), () => gitApi.discard(cwd, confirmPaths, staged))
    setConfirm(null)
  }, [cwd, confirmPaths, runAction, status, t])

  const deleteUntracked = useCallback((paths: readonly string[]) => {
    setConfirmPaths(paths)
    setConfirm('clean')
  }, [])

  const doClean = useCallback(async () => {
    await runAction(t('git.deleteFile'), () => gitApi.clean(cwd, confirmPaths))
    setConfirm(null)
  }, [cwd, confirmPaths, runAction, t])

  const openDiff = useCallback(async (file: GitFile, untracked: boolean, staged: boolean) => {
    if (isImagePath(file.path)) {
      // Image: load both versions for the side-by-side preview.
      const oldSource: 'head' | 'index' = staged ? 'index' : 'head'
      let oldUrl: string | null = null
      let oldError: string | null = null
      let newUrl: string | null = null
      try {
        const old = await gitApi.blob(cwd, file.path, oldSource)
        oldUrl = old.dataUrl
      } catch (error) {
        oldError = error instanceof Error ? error.message : String(error)
      }
      try {
        const fresh = await gitApi.blob(cwd, file.path, 'worktree')
        newUrl = fresh.dataUrl
      } catch {
        newUrl = null
      }
      setImageDiff({ file, oldUrl, newUrl, oldError })
      return
    }
    try {
      const { diff: text } = await gitApi.diff(cwd, file.path, staged, untracked)
      setDiff({ file, rows: parseUnifiedDiff(text), staged })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [cwd])

  // --- commit / push --------------------------------------------------------

  const commit = useCallback(async (andPush: boolean) => {
    const trimmed = message.trim()
    if (trimmed.length === 0) return
    setBusy(t('git.committing'))
    setError(null)
    setPushFail(null)
    try {
      const { hash } = await gitApi.commit(cwd, trimmed)
      setLastHash(hash)
      setMessage('')
      flash(t('git.committed'))
      if (andPush) {
        setBusy(t('git.push'))
        await gitApi.push(cwd)
        flash(t('git.pushed'))
      }
      await refresh()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (andPush) {
        const noUpstream = /no upstream branch|没有上游|未设置上游/i.test(error.message)
        setPushFail({ message: error.message, noUpstream })
      } else {
        setError(error.message)
      }
    } finally {
      setBusy(null)
    }
  }, [cwd, message, refresh, t, flash])

  const push = useCallback(async () => {
    setBusy(t('git.push'))
    setError(null)
    setPushFail(null)
    try {
      await gitApi.push(cwd)
      flash(t('git.pushed'))
      await refresh()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      setPushFail({ message: error.message, noUpstream: /upstream/i.test(error.message) })
    } finally {
      setBusy(null)
    }
  }, [cwd, refresh, t, flash])

  const undoLastCommit = useCallback(async () => {
    if (lastHash === null) return
    setBusy(t('git.undoCommit'))
    try {
      await gitApi.undoCommit(cwd, lastHash)
      setPushFail(null)
      setMessage('')
      flash(t('git.undoCommit'))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [cwd, lastHash, refresh, t, flash])

  // --- generation -----------------------------------------------------------

  const generateMessage = useCallback(async () => {
    if (genState === 'running') {
      // Stop: ask the host to abort; the stream ends with "stop" and the
      // partial text stays in the box.
      setGenState('stopping')
      void gitApi.generateCancel(`gen-${generateToken.current}`)
      return
    }
    if (genState === 'stopping') return
    generateToken.current += 1
    const token = `gen-${generateToken.current}`
    originalMessage.current = message
    setMessage('')
    setGenState('running')
    setGenElapsed(0)
    setError(null)
    try {
      const full = await gitApi.generate(cwd, token, (delta) => { setMessage(prev => prev + delta) }, genModel)
      setMessage(full)
    } catch (err) {
      setMessage(originalMessage.current)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenState('idle')
    }
  }, [genState, cwd, message, genModel])

  // --- branch / history / misc ---------------------------------------------

  const switchBranch = useCallback(async (branch: string, create: boolean) => {
    await runAction(t('git.switchTo'), () => gitApi.switch(cwd, branch, create))
    setBranchMenuOpen(false)
    setNewBranch('')
  }, [cwd, runAction, t])

  const pull = useCallback(async () => {
    await runAction(t('git.pull'), () => gitApi.pull(cwd))
  }, [cwd, runAction, t])

  const abortMerge = useCallback(() => {
    setConfirmPaths([])
    setConfirm('merge-abort')
  }, [])

  const doMergeAbort = useCallback(async () => {
    await runAction(t('git.abortMerge'), () => gitApi.mergeAbort(cwd))
    setConfirm(null)
  }, [cwd, runAction, t])

  const completeMerge = useCallback(async () => {
    await runAction(t('git.completeMerge'), () => gitApi.mergeComplete(cwd))
  }, [cwd, runAction, t])

  const doResetHard = useCallback(async () => {
    await runAction(t('git.reset'), () => gitApi.reset(cwd, 'hard'))
    setConfirm(null)
  }, [cwd, runAction, t])

  const cleanAllUntracked = useCallback(() => {
    setConfirmPaths(status?.untracked.map(f => f.path) ?? [])
    setConfirm('clean')
  }, [status])

  const openMoreMenu = useCallback(async () => {
    setMoreMenuOpen(v => !v)
    setBranchMenuOpen(false)
    setRulesMenuOpen(false)
    if (!moreMenuOpen) {
      try {
        const { entries } = await gitApi.stashList(cwd)
        setStashEntries(entries)
      } catch {
        setStashEntries([])
      }
    }
  }, [moreMenuOpen, cwd])

  const openRulesMenu = useCallback(async () => {
    const opening = ! rulesMenuOpen
    setRulesMenuOpen(v => !v)
    setBranchMenuOpen(false)
    setMoreMenuOpen(false)
    if (opening) {
      try {
        setRules(await gitApi.rules(cwd, repo.name))
      } catch {
        setRules(null)
      }
    }
  }, [rulesMenuOpen, cwd, repo.name])

  const reloadRules = useCallback(async () => {
    try {
      setRules(await gitApi.rules(cwd, repo.name))
    } catch {
      setRules(null)
    }
  }, [cwd, repo.name])

  const saveGenModel = useCallback((model: string | undefined) => {
    setGenModel(model)
    try {
      if (model === undefined) window.localStorage.removeItem('dsh-git-gen-model')
      else window.localStorage.setItem('dsh-git-gen-model', model)
    } catch {
      // Storage unavailable (private mode): the selection still applies for
      // the panel's lifetime.
    }
  }, [])

  // --- render ---------------------------------------------------------------

  const s = status
  const totalChanges = (s?.staged.length ?? 0) + (s?.unstaged.length ?? 0) + (s?.untracked.length ?? 0) + (s?.conflicted.length ?? 0)
  const nodes = layoutGraph(commits)
  const laneCount = Math.max(1, ...nodes.map(n => n.lane + 1))
  const mergeActive = s?.mergeState === 'merge'
  const conflictCount = s?.conflicted.length ?? 0
  const commitDisabled = message.trim().length === 0 || busy !== null || conflictCount > 0

  return (
    <section className={css.card}>
      <header className={css.header}>
        <span className={css.repoTitle} title={cwd}>
          {isRoot ? t('git.rootRepo') : repo.name}
          {repo.isWorktree ? ` (${t('git.worktree')})` : ''}
        </span>
        <div className={css.branchWrap}>
          <button className={css.chip} onClick={() => { setBranchMenuOpen(v => !v); setMoreMenuOpen(false); setRulesMenuOpen(false) }}>
            {s?.branch ?? '—'}
          </button>
          {branchMenuOpen && (
            <div className={css.menu}>
              <div className={css.menuLabel}>{t('git.switchTo')}</div>
              {branches?.local.map(b => (
                <button
                  key={b.name}
                  className={css.menuItem}
                  disabled={b.current || busy !== null}
                  onClick={() => void switchBranch(b.name, false)}
                >
                  {b.name}{b.current ? ' ✓' : ''}
                </button>
              ))}
              {branches?.remote.map(remote => (
                <button
                  key={remote}
                  className={`${css.menuItem} ${css.menuMuted}`}
                  disabled
                  title={remote}
                >
                  {remote}
                </button>
              ))}
              <div className={css.menuDivider} />
              <div className={css.newBranchRow}>
                <input
                  className={css.branchInput}
                  placeholder={t('git.branchPlaceholder')}
                  value={newBranch}
                  onChange={(e) => { setNewBranch(e.target.value) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newBranch.trim()) void switchBranch(newBranch.trim(), true) }}
                />
                <button
                  className={css.smallBtn}
                  disabled={newBranch.trim().length === 0 || busy !== null}
                  onClick={() => void switchBranch(newBranch.trim(), true)}
                >
                  {t('git.create')}
                </button>
              </div>
            </div>
          )}
        </div>
        {s?.upstream !== undefined && <span className={css.upstream}>{s.upstream}</span>}
        {s !== null && s.ahead > 0 && <span className={`${css.sync} ${css.ahead}`}>{t('git.ahead', { n: s.ahead })}</span>}
        {s !== null && s.behind > 0 && <span className={`${css.sync} ${css.behind}`}>{t('git.behind', { n: s.behind })}</span>}
        {s !== null && s.mergeState !== null && (
          <span className={css.mergeBadge}>{t('git.mergeInProgress')}</span>
        )}
        <div className={css.headerActions}>
          <button className={css.iconBtn} title={t('git.pull')} disabled={busy !== null} onClick={() => void pull()}>↻</button>
          <button className={css.iconBtn} title={t('git.refresh')} disabled={loading || busy !== null} onClick={() => void refresh()}>⟳</button>
          <div className={css.moreWrap}>
            <button className={css.iconBtn} title="⋯" disabled={busy !== null} onClick={() => void openMoreMenu()}>⋯</button>
            {moreMenuOpen && (
              <div className={`${css.menu} ${css.menuRight}`}>
                <button className={css.menuItem} onClick={() => { setMoreMenuOpen(false); void push() }}>{t('git.push')}</button>
                <button className={css.menuItem} onClick={() => { setMoreMenuOpen(false); void runAction(t('git.stashPush'), () => gitApi.stashPush(cwd)) }}>{t('git.stashPush')}</button>
                {stashEntries.map(entry => (
                  <button
                    key={entry.name}
                    className={css.menuItem}
                    title={t('git.stashPop')}
                    onClick={() => { setMoreMenuOpen(false); void runAction(t('git.stashPop'), () => gitApi.stashPop(cwd)) }}
                  >
                    {entry.name}{entry.message.length > 0 ? ` ${entry.message}` : ''} ↑
                  </button>
                ))}
                <div className={css.menuDivider} />
                <button className={css.menuItem} onClick={() => { setMoreMenuOpen(false); setConfirmPaths([]); setConfirm('reset-hard') }}>{t('git.resetHard')}</button>
                <button className={css.menuItem} onClick={() => { setMoreMenuOpen(false); cleanAllUntracked() }}>{t('git.cleanUntracked')}</button>
                {mergeActive && (
                  <button className={css.menuItem} onClick={() => { setMoreMenuOpen(false); abortMerge() }}>{t('git.abortMerge')}</button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Merge state hint bar with its terminal actions. */}
      {s !== null && s.mergeState !== null && (
        <div className={css.mergeBar}>
          {s.mergeState === 'merge' ? (
            conflictCount > 0
              ? <span>{t('git.mergeConflicts', { n: conflictCount })}</span>
              : (s.staged.length === 0
                ? <span>{t('git.mergeCleanIndex')}</span>
                : <span>{t('git.mergeStageToCommit')}</span>)
          ) : (
            <span>{t('git.mergeTerminalHint', { op: s.mergeState })}</span>
          )}
          {s.mergeState === 'merge' && s.staged.length === 0 && conflictCount === 0 && (
            <button className={css.smallBtn} disabled={busy !== null} onClick={() => void completeMerge()}>{t('git.completeMerge')}</button>
          )}
          {s.mergeState === 'merge' && (
            <button className={css.ghostBtn} disabled={busy !== null} onClick={() => { abortMerge() }}>{t('git.abortMerge')}</button>
          )}
        </div>
      )}

      {error !== null && <div className={css.error}>{error}</div>}
      {notice !== null && <div className={css.toast}>{notice}</div>}

      <section className={css.commitBox}>
        <textarea
          className={css.message}
          placeholder={t('git.commitPlaceholder')}
          value={message}
          rows={Math.min(6, Math.max(2, message.split('\n').length))}
          onChange={(e) => { setMessage(e.target.value) }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              void commit(false)
            }
          }}
        />
        <div className={css.commitRow}>
          <div className={css.genWrap}>
            <button
              className={css.ghostBtn}
              disabled={genState === 'stopping' || busy !== null}
              title={genState === 'running' ? t('git.stop') : t('git.generate')}
              onClick={() => void generateMessage()}
            >
              {genState === 'running' ? t('git.stop') : genState === 'stopping' ? t('git.stopping') : `✦ ${t('git.generate')}`}
            </button>
            <button className={css.ghostBtn} title={t('git.rules')} onClick={() => void openRulesMenu()}>⚙</button>
            {rulesMenuOpen && (
              <div className={css.menu}>
                <button className={css.menuItem} onClick={() => { setRulesMenuOpen(false); setRuleEditorOpen(true) }}>{t('git.editRules')}</button>
                <button className={css.menuItem} onClick={() => { setRulesMenuOpen(false); setModelModalOpen(true) }}>{t('git.genModel')}</button>
                <button
                  className={css.menuItem}
                  onClick={() => {
                    setRulesMenuOpen(false)
                    try {
                      void navigator.clipboard.writeText(`${rules?.systemPrompt ?? ''}\n\n${rules?.userContext ?? ''}`)
                      flash(t('git.copied'))
                    } catch {
                      setError(t('git.copyFailed'))
                    }
                  }}
                >
                  {t('git.copyRules')}
                </button>
                <div className={css.menuDivider} />
                <div className={css.menuLabel}>
                  {rules === null
                    ? t('git.rulesSource', { source: '—' })
                    : t('git.rulesSource', { source: rules.source === 'repo' ? t('git.sourceRepo') : rules.source === 'global' ? t('git.sourceGlobal') : t('git.sourceBuiltin') })}
                </div>
              </div>
            )}
            {genState === 'running' && (
              <span className={css.genLive}>⟳ {t('git.generating', { n: genElapsed })}</span>
            )}
          </div>
          <span className={css.stagedCount}>{t('git.fileCount', { n: s?.staged.length ?? 0 })}</span>
          <div className={css.commitActions}>
            <button
              className={css.primaryBtn}
              disabled={commitDisabled}
              title={commitDisabled
                ? (conflictCount > 0 ? t('git.conflictBlockCommit') : t('git.commitDisabled'))
                : undefined}
              onClick={() => void commit(true)}
            >
              {t('git.commitAndPush')}
            </button>
            <button className={css.primaryBtn} disabled={commitDisabled} onClick={() => void commit(false)}>
              {t('git.commit')}
            </button>
          </div>
        </div>
      </section>

      {s !== null && s.conflicted.length > 0 && (
        <Group
          title={t('git.conflicts')}
          count={s.conflicted.length}
          tone="conflict"
          bulkLabel={t('git.markResolvedAll')}
          onBulk={() => { stage(s.conflicted.map(f => f.path)) }}
        >
          {s.conflicted.map(f => (
            <FileRow
              key={f.path}
              file={f}
              onOpen={() => void openDiff(f, false, false)}
              onStage={() => { stage([f.path]) }}
              t={t}
              busy={busy}
            />
          ))}
        </Group>
      )}
      {s !== null && s.staged.length > 0 && (
        <Group
          title={t('git.staged')}
          count={s.staged.length}
          tone="staged"
          bulkLabel={t('git.unstageAll')}
          onBulk={() => { unstage(s.staged.map(f => f.path)) }}
        >
          {s.staged.map(f => (
            <FileRow
              key={f.path}
              file={f}
              onOpen={() => void openDiff(f, false, true)}
              onUnstage={() => { unstage([f.path]) }}
              onDiscard={() => { confirmDiscard([f.path]) }}
              t={t}
              busy={busy}
            />
          ))}
        </Group>
      )}
      {s !== null && s.unstaged.length > 0 && (
        <Group
          title={t('git.changes')}
          count={s.unstaged.length}
          tone="changes"
          bulkLabel={t('git.stageAll')}
          onBulk={() => { stage(s.unstaged.map(f => f.path)) }}
        >
          {s.unstaged.map(f => (
            <FileRow
              key={f.path}
              file={f}
              onOpen={() => void openDiff(f, false, false)}
              onStage={() => { stage([f.path]) }}
              onDiscard={() => { confirmDiscard([f.path]) }}
              t={t}
              busy={busy}
            />
          ))}
        </Group>
      )}
      {s !== null && s.untracked.length > 0 && (
        <Group
          title={t('git.untracked')}
          count={s.untracked.length}
          tone="untracked"
          bulkLabel={t('git.stageAll')}
          onBulk={() => { stage(s.untracked.map(f => f.path)) }}
        >
          <UntrackedTree
            files={s.untracked}
            onOpen={(f, untracked) => void openDiff(f, untracked, false)}
            onStage={stage}
            onDelete={deleteUntracked}
            t={t}
            busy={busy}
          />
        </Group>
      )}
      {s !== null && totalChanges === 0 && <div className={css.cleanNote}>{t('git.clean')}</div>}

      <section className={css.history}>
        <button className={css.historyToggle} onClick={() => { setHistoryOpen(v => !v) }}>
          <span className={css.chev}>{historyOpen ? '▾' : '▸'}</span>
          {t('git.history')}
        </button>
        {historyOpen && (
          <div className={css.historyBody}>
            {commits.length === 0
              ? <div className={css.cleanNote}>{t('git.noCommits')}</div>
              : (
                <div className={css.graphWrap}>
                  <CommitGraph nodes={nodes} commits={commits} headHash={s?.head ?? ''} />
                  <ul className={css.commitList} style={{ paddingLeft: laneCount * 26 + 8 }}>
                    {commits.map(c => (
                      <li
                        key={c.hash}
                        className={css.commitRow}
                        onMouseEnter={(e) => {
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          setHover({ commit: c, x: rect.left, y: rect.bottom })
                        }}
                        onMouseLeave={() => { setHover(null) }}
                      >
                        <span className={css.commitSubj}>{c.subject}</span>
                        <span className={css.commitMeta}>{c.author} · {formatDate(c.date)}</span>
                      </li>
                    ))}
                    <li ref={sentinelRef} className={css.sentinel} aria-hidden="true" />
                    {hasMore && <li className={css.cleanNote}>{t('git.loadMore')}</li>}
                  </ul>
                </div>
              )}
          </div>
        )}
      </section>

      {diff !== null && (
        <DiffDrawer
          file={diff.file}
          rows={diff.rows}
          staged={diff.staged}
          wrap={wrap}
          onToggleWrap={() => { setWrap(v => !v) }}
          onClose={() => { setDiff(null) }}
          t={t}
        />
      )}

      {imageDiff !== null && (
        <ImageDiff
          file={imageDiff.file}
          oldUrl={imageDiff.oldUrl}
          newUrl={imageDiff.newUrl}
          oldError={imageDiff.oldError}
          onFullscreen={(blob, which) => { setImageFull(blob); setImageFullWhich(which) }}
          onClose={() => { setImageDiff(null) }}
          t={t}
        />
      )}

      {imageFull !== null && (
        <ImageFullscreen
          blob={imageFull}
          which={imageFullWhich}
          onSwitch={() => { setImageFullWhich(w => (w === 'old' ? 'new' : 'old')) }}
          onClose={() => { setImageFull(null) }}
          t={t}
        />
      )}

      {hover !== null && <HoverCard commit={hover.commit} x={hover.x} y={hover.y} t={t} />}

      {confirm !== null && (
        <ConfirmModal
          kind={confirm}
          count={confirmPaths.length}
          onConfirm={() => {
            if (confirm === 'discard') void doDiscard()
            else if (confirm === 'reset-hard') void doResetHard()
            else if (confirm === 'clean') void doClean()
            else void doMergeAbort()
          }}
          onCancel={() => { setConfirm(null) }}
          t={t}
        />
      )}

      {pushFail !== null && (
        <div className={css.modalBackdrop} onClick={() => { setPushFail(null) }}>
          <div className={css.modal} onClick={(e) => { e.stopPropagation() }}>
            <div className={css.modalTitle}>{t('git.pushFailed')}</div>
            {pushFail.noUpstream
              ? (
                <pre className={css.modalError}>
                  {t('git.pushNoUpstreamHint', { remote: branches?.upstream?.split('/')[0] ?? 'origin', branch: s?.branch ?? '' })}
                </pre>
              )
              : <pre className={css.modalError}>{pushFail.message}</pre>}
            <div className={css.modalActions}>
              <button className={css.ghostBtn} onClick={() => { setPushFail(null) }}>{t('git.close')}</button>
              <button className={css.primaryBtn} disabled={busy !== null} onClick={() => void push()}>{t('git.retryPush')}</button>
              <button className={css.dangerBtn} disabled={busy !== null || lastHash === null} onClick={() => void undoLastCommit()}>{t('git.undoCommit')}</button>
            </div>
          </div>
        </div>
      )}

      {ruleEditorOpen && (
        <RuleEditor
          rules={rules}
          onSave={(scope, systemPrompt, userContext) =>
            runAction(t('git.savingRules'), () => gitApi.rulesSave(cwd, repo.name, scope, systemPrompt, userContext))
              .then(() => {
                setRuleEditorOpen(false)
                void reloadRules()
              })}
          onReset={() => runAction(t('git.savingRules'), () => gitApi.rulesReset(cwd, repo.name, rules?.scope === 'repo' ? 'repo' : 'global'))}
          onClose={() => { setRuleEditorOpen(false) }}
          t={t}
        />
      )}

      {modelModalOpen && (
        <ModelModal
          models={models}
          current={genModel}
          onPick={saveGenModel}
          onClose={() => { setModelModalOpen(false) }}
          t={t}
        />
      )}
    </section>
  )
}

// --- Subcomponents ----------------------------------------------------------

interface GroupProps {
  title: string
  count: number
  tone: 'conflict' | 'staged' | 'changes' | 'untracked'
  bulkLabel?: string
  onBulk?: () => void
  children: React.ReactNode
}

/** A collapsible working-tree group with an optional hover bulk action. */
function Group({ title, count, tone, bulkLabel, onBulk, children }: GroupProps) {
  const [open, setOpen] = useState(true)
  return (
    <section className={css.group}>
      <button className={`${css.groupHead} ${css[`group-${tone}`]}`} onClick={() => { setOpen(v => !v) }}>
        <span className={css.chev}>{open ? '▾' : '▸'}</span>
        {title}
        <span className={css.groupCount}>{count}</span>
        {bulkLabel !== undefined && onBulk !== undefined && (
          <span className={css.groupBulk} onClick={(e) => { e.stopPropagation(); onBulk() }}>
            {bulkLabel}
          </span>
        )}
      </button>
      {open && <div className={css.groupBody}>{children}</div>}
    </section>
  )
}

interface FileRowProps {
  file: GitFile
  onOpen: () => void
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
  onDelete?: () => void
  t: TFunc
  busy: string | null
}

/** One working-tree file with a status letter and hover actions. */
function FileRow({ file, onOpen, onStage, onUnstage, onDiscard, onDelete, t, busy }: FileRowProps) {
  const letter = statusLetter(file.status, t)
  return (
    <div className={css.fileRow} onClick={onOpen}>
      <span className={`${css.statusBadge} ${css[`st-${letter}`]}`}>{letter}</span>
      <span className={css.fileName} title={file.path}>
        {file.renameFrom !== undefined ? `${basename(file.renameFrom)} → ` : ''}{basename(file.path)}
      </span>
      {dirname(file.path) !== '' && <span className={css.fileDir}>{dirname(file.path)}</span>}
      <span className={css.fileActions} onClick={(e) => { e.stopPropagation() }}>
        {onStage !== undefined && (
          <button className={css.rowBtn} title={t('git.stage')} disabled={busy !== null} onClick={onStage}>＋</button>
        )}
        {onUnstage !== undefined && (
          <button className={css.rowBtn} title={t('git.unstage')} disabled={busy !== null} onClick={onUnstage}>－</button>
        )}
        {onDiscard !== undefined && (
          <button className={css.rowBtn} title={t('git.discard')} disabled={busy !== null} onClick={onDiscard}>⟲</button>
        )}
        {onDelete !== undefined && (
          <button className={css.rowBtn} title={t('git.deleteFile')} disabled={busy !== null} onClick={onDelete}>✕</button>
        )}
      </span>
    </div>
  )
}

/** The status letter shown in the badge (the untracked letter is locale-owned). */
function statusLetter(status: string, t: TFunc): string {
  if (status === '??') return t('git.letterUntracked')
  const [index, worktree] = status
  if (index === 'U' || worktree === 'U') return t('git.letterUntracked')
  if (index !== ' ' && index !== undefined) return index
  if (worktree !== ' ' && worktree !== undefined) return worktree
  return 'M'
}

interface UntrackedTreeProps {
  files: readonly GitFile[]
  onOpen: (file: GitFile, untracked: boolean) => void
  onStage: (paths: readonly string[]) => void
  onDelete: (paths: readonly string[]) => void
  t: TFunc
  busy: string | null
}

/** Untracked files as a two-level directory tree (root files first). */
function UntrackedTree({ files, onOpen, onStage, onDelete, t, busy }: UntrackedTreeProps) {
  const rootFiles = files.filter(f => dirname(f.path) === '')
  const tree = useMemo(() => buildUntrackedTree(files), [files])
  const shown = files.slice(0, 200)
  const shownSet = useMemo(() => new Set(shown.map(f => f.path)), [shown])
  const filesIn = (directory: string): string[] =>
    files.filter(f => dirname(f.path).startsWith(directory)).map(f => f.path)
  return (
    <div className={css.untrackedTree}>
      {rootFiles.map(f => (
        <FileRow
          key={f.path}
          file={f}
          onOpen={() => { onOpen(f, true) }}
          onStage={() => { onStage([f.path]) }}
          onDelete={() => { onDelete([f.path]) }}
          t={t}
          busy={busy}
        />
      ))}
      {tree.map(node => (
        <div key={node.dir}>
          <div
            className={css.treeDir}
            onClick={() => { onStage(filesIn(node.dir)) }}
            title={t('git.stageAll')}
          >
            <span className={css.chev}>▾</span>
            {node.dir}/
            <span className={css.groupCount}>{filesIn(node.dir).length}</span>
            <span
              className={css.groupBulk}
              onClick={(e) => { e.stopPropagation(); onDelete(filesIn(node.dir)) }}
            >
              {t('git.deleteFile')}
            </span>
          </div>
          {files
            .filter(f => dirname(f.path).startsWith(node.dir) && shownSet.has(f.path))
            .map(f => (
              <div key={f.path} className={css.treeFileIndent}>
                <FileRow
                  file={f}
                  onOpen={() => { onOpen(f, true) }}
                  onStage={() => { onStage([f.path]) }}
                  onDelete={() => { onDelete([f.path]) }}
                  t={t}
                  busy={busy}
                />
              </div>
            ))}
          {node.subdirs.map(sub => (
            <div key={sub} className={`${css.treeFileIndent} ${css.treeSubdir}`}>{node.dir}/{sub}/</div>
          ))}
        </div>
      ))}
    </div>
  )
}

interface DiffDrawerProps {
  file: GitFile
  rows: readonly DiffRow[]
  staged: boolean
  wrap: boolean
  onToggleWrap: () => void
  onClose: () => void
  t: TFunc
}

/** The two-column diff overlay, anchored to the panel's left edge. */
function DiffDrawer({ file, rows, staged, wrap, onToggleWrap, onClose, t }: DiffDrawerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const { add, del } = diffCounts(rows)
  const letter = statusLetter(file.status, t)

  return (
    <div className={css.drawer} role="dialog" aria-label={file.path}>
      <div className={css.drawerHeader}>
        <span className={`${css.statusBadge} ${css[`st-${letter}`]}`}>{letter}</span>
        <span className={css.drawerFile} title={file.path}>{basename(file.path)}</span>
        {dirname(file.path) !== '' && <span className={css.fileDir}>{dirname(file.path)}</span>}
        <span className={css.diffCounts}>
          <span className={css.addCount}>+{add}</span>
          <span className={css.delCount}>−{del}</span>
        </span>
        <button className={css.rowBtn} title={t('git.wrap')} onClick={onToggleWrap}>{wrap ? '⇥' : '⇤'}</button>
        <button className={css.rowBtn} title={t('git.close')} onClick={onClose}>✕</button>
      </div>
      <div className={css.drawerBody}>
        {rows.length === 0
          ? <div className={css.cleanNote}>{t('git.noDiff')}</div>
          : (
            <table className={css.diffTable}>
              <tbody>
                {rows.map((row, i) => {
                  if (row.kind === 'hunk') {
                    return (
                      <tr key={i} className={css.hunkRow}>
                        <td colSpan={4} className={css.hunkCell}>{row.text}</td>
                      </tr>
                    )
                  }
                  const leftText = row.kind === 'del' || row.kind === 'meta' ? row.text : row.kind === 'ctx' ? row.text : ''
                  const rightText = row.kind === 'add' || row.kind === 'meta' ? row.text : row.kind === 'ctx' ? row.text : ''
                  const leftNo = row.oldNo
                  const rightNo = row.newNo
                  return (
                    <tr key={i} className={css[`row-${row.kind}`]}>
                      <td className={css.noCell}>{leftNo ?? ''}</td>
                      <td className={`${css.codeCell} ${wrap ? css.wrap : ''}`}>{leftText}</td>
                      <td className={css.noCell}>{rightNo ?? ''}</td>
                      <td className={`${css.codeCell} ${wrap ? css.wrap : ''}`}>{rightText}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
      </div>
      {/* staged marker keeps the drawer header honest about the version pair */}
      <span className={css.stagedTag} aria-hidden="true">{staged ? t('git.pairStaged') : t('git.pairWorktree')}</span>
    </div>
  )
}

interface ImageDiffProps {
  file: GitFile
  oldUrl: string | null
  newUrl: string | null
  oldError: string | null
  onFullscreen: (blob: GitBlob, which: 'old' | 'new') => void
  onClose: () => void
  t: TFunc
}

/** Side-by-side image version preview; each image opens the fullscreen view. */
function ImageDiff({ file, oldUrl, newUrl, oldError, onFullscreen, onClose, t }: ImageDiffProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const open = (url: string | null, which: 'old' | 'new') => {
    if (url === null) return
    onFullscreen({ mime: 'image', size: 0, dataUrl: url }, which)
  }

  return (
    <div className={css.drawer} role="dialog" aria-label={file.path}>
      <div className={css.drawerHeader}>
        <span className={css.drawerFile} title={file.path}>{basename(file.path)}</span>
        <span className={css.fileDir}>{dirname(file.path)}</span>
        <button className={css.rowBtn} title={t('git.close')} onClick={onClose}>✕</button>
      </div>
      <div className={css.imageDiff}>
        <div className={css.imagePane}>
          <div className={css.imageLabel}>{t('git.imageOld')}</div>
          {oldUrl !== null
            ? <img src={oldUrl} alt={t('git.imageOld')} className={css.imagePreview} onClick={() => { open(oldUrl, 'old') }} />
            : <div className={css.cleanNote}>{oldError ?? '—'}</div>}
        </div>
        <div className={css.imagePane}>
          <div className={css.imageLabel}>{t('git.imageNew')}</div>
          {newUrl !== null
            ? <img src={newUrl} alt={t('git.imageNew')} className={css.imagePreview} onClick={() => { open(newUrl, 'new') }} />
            : <div className={css.cleanNote}>{t('git.imageMissing')}</div>}
        </div>
      </div>
    </div>
  )
}

interface ImageFullscreenProps {
  blob: GitBlob
  which: 'old' | 'new'
  onSwitch: () => void
  onClose: () => void
  t: TFunc
}

/** Fullscreen 1:1 image view (checkerboard background, scrollable). */
function ImageFullscreen({ blob, which, onSwitch, onClose, t }: ImageFullscreenProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onSwitch()
      else if (e.key === 'ArrowRight') onSwitch()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose, onSwitch])

  return (
    <div className={css.imageBackdrop} onClick={onClose}>
      <div className={css.imageFull} onClick={(e) => { e.stopPropagation() }}>
        <div className={css.imageFullBar}>
          <span>{which === 'old' ? t('git.imageOld') : t('git.imageNew')}</span>
          <button className={css.rowBtn} title={t('git.imageSwitch')} onClick={onSwitch}>⇄</button>
          <button className={css.rowBtn} title={t('git.close')} onClick={onClose}>✕</button>
        </div>
        <div className={css.imageFullScroll}>
          <img src={blob.dataUrl} alt="" className={css.imageFullImg} />
        </div>
      </div>
    </div>
  )
}

interface GraphProps {
  nodes: readonly GraphNode[]
  commits: readonly GitCommit[]
  headHash: string
}

/** The SVG lane graph drawn to the left of the commit list. */
function CommitGraph({ nodes, commits, headHash }: GraphProps) {
  const ROW = 44
  const LANE = 26
  const height = Math.max(nodes.length, 1) * ROW
  const width = nodes.length > 0
    ? Math.max(...nodes.map(n => n.lane + 1)) * LANE
    : LANE

  return (
    <svg className={css.graph} width={width} height={height} aria-hidden="true">
      {commits.map((commit, i) => {
        const node = nodes[i] as GraphNode
        const x = node.lane * LANE + LANE / 2
        const y = i * ROW + ROW / 2
        return (
          <g key={commit.hash}>
            {commit.parents.map((parent) => {
              const parentNode = nodes.find(n => n.hash === parent)
              if (parentNode === undefined) return null
              const px = parentNode.lane * LANE + LANE / 2
              const py = (parentNode.row * ROW) + ROW / 2
              const midY = (y + py) / 2
              return (
                <path
                  key={parent}
                  d={`M ${x} ${y} L ${x} ${midY} Q ${x} ${py} ${px} ${py}`}
                  className={css.edge}
                  fill="none"
                />
              )
            })}
            <circle
              cx={x}
              cy={y}
              r={5}
              className={css.node}
              {...(commit.hash === headHash ? { stroke: 'var(--dsw-alias-accent, #888)', strokeWidth: 2 } : {})}
            />
          </g>
        )
      })}
    </svg>
  )
}

interface HoverCardProps {
  commit: GitCommit
  x: number
  y: number
  t: TFunc
}

/** The VS Code-style hover details for one commit. */
function HoverCard({ commit, x, y, t }: HoverCardProps) {
  const card = (
    <div className={css.hoverCard}>
      <div className={css.hoverSubj}>{commit.subject}</div>
      {commit.body.length > 0 && <div className={css.hoverBody}>{commit.body}</div>}
      <div className={css.hoverMeta}>{`${commit.author} <${commit.email}> · ${formatDate(commit.date)}`}</div>
      <div className={css.hoverHash}>{commit.hash}</div>
      {commit.stat !== undefined && (
        <div className={css.hoverStat}>
          {t('git.fileCount', { n: commit.stat.files })} · +{commit.stat.insertions} −{commit.stat.deletions}
        </div>
      )}
    </div>
  )
  return <div className={css.hoverAnchor} style={{ left: x, top: y }}>{card}</div>
}

interface ConfirmModalProps {
  kind: ConfirmKind
  count: number
  onConfirm: () => void
  onCancel: () => void
  t: TFunc
}

/** One confirmation dialog per destructive action. */
function ConfirmModal({ kind, count, onConfirm, onCancel, t }: ConfirmModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onCancel])
  const title = kind === 'discard'
    ? t('git.confirmDiscard')
    : kind === 'reset-hard'
      ? t('git.confirmResetHard')
      : kind === 'clean'
        ? t('git.confirmClean')
        : t('git.confirmMergeAbort')
  return (
    <div className={css.modalBackdrop} onClick={onCancel}>
      <div className={css.modal} onClick={(e) => { e.stopPropagation() }}>
        <div className={css.modalTitle}>
          {title}
          {kind === 'discard' || kind === 'clean' ? ` (${count})` : ''}
        </div>
        <div className={css.modalActions}>
          <button className={css.ghostBtn} onClick={onCancel}>{t('git.cancel')}</button>
          <button className={css.dangerBtn} onClick={onConfirm}>{t('git.confirm')}</button>
        </div>
      </div>
    </div>
  )
}

interface RuleEditorProps {
  rules: GitRules | null
  onSave: (scope: 'global' | 'repo', systemPrompt: string, userContext: string) => Promise<void>
  onReset: () => Promise<void>
  onClose: () => void
  t: TFunc
}

/** Edit the commit rule: source selector, both prompts, save/reset/copy. */
function RuleEditor({ rules, onSave, onReset, onClose, t }: RuleEditorProps) {
  const [scope, setScope] = useState<'global' | 'repo'>(rules?.scope === 'repo' ? 'repo' : 'global')
  const [systemPrompt, setSystemPrompt] = useState(rules?.systemPrompt ?? '')
  const [userContext, setUserContext] = useState(rules?.userContext ?? '')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (systemPrompt.trim().length === 0) return
    setBusy(true)
    try {
      await onSave(scope, systemPrompt, userContext)
    } finally {
      setBusy(false)
    }
  }
  const reset = async () => {
    setBusy(true)
    try {
      await onReset()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.modalBackdrop} onClick={onClose}>
      <div className={css.modalLarge} onClick={(e) => { e.stopPropagation() }}>
        <div className={css.modalTitle}>{t('git.rulesTitle')}</div>
        <div className={css.ruleSourceRow}>
          <label>
            <input type="radio" name="rule-scope" checked={scope === 'global'} onChange={() => { setScope('global') }} />
            {t('git.sourceGlobal')}
          </label>
          <label>
            <input type="radio" name="rule-scope" checked={scope === 'repo'} onChange={() => { setScope('repo') }} />
            {t('git.sourceRepo')}
          </label>
        </div>
        <div className={css.rulePanels}>
          <div className={css.rulePanel}>
            <label className={css.ruleLabel}>{t('git.ruleSystem')}</label>
            <textarea
              className={css.ruleText}
              value={systemPrompt}
              onChange={(e) => { setSystemPrompt(e.target.value) }}
              rows={10}
            />
            <label className={css.ruleLabel}>{t('git.ruleUser')}</label>
            <textarea
              className={css.ruleText}
              value={userContext}
              onChange={(e) => { setUserContext(e.target.value) }}
              rows={8}
            />
          </div>
          <div className={css.rulePanel}>
            <label className={css.ruleLabel}>{t('git.rulePreview')}</label>
            <pre className={css.rulePreview}>{userContext.length > 0 ? userContext : '—'}</pre>
          </div>
        </div>
        <div className={css.modalActions}>
          <button className={css.ghostBtn} disabled={busy} onClick={() => void reset()}>{t('git.rulesReset')}</button>
          <button className={css.ghostBtn} disabled={busy} onClick={onClose}>{t('git.cancel')}</button>
          <button className={css.primaryBtn} disabled={busy || systemPrompt.trim().length === 0} onClick={() => void save()}>{t('git.save')}</button>
        </div>
      </div>
    </div>
  )
}

interface ModelModalProps {
  models: readonly GitModel[]
  current: string | undefined
  onPick: (model: string | undefined) => void
  onClose: () => void
  t: TFunc
}

/** Pick the generation model (or clear the override). */
function ModelModal({ models, current, onPick, onClose, t }: ModelModalProps) {
  return (
    <div className={css.modalBackdrop} onClick={onClose}>
      <div className={css.modal} onClick={(e) => { e.stopPropagation() }}>
        <div className={css.modalTitle}>{t('git.genModel')}</div>
        <div className={css.modelList}>
          <button className={css.menuItem} onClick={() => { onPick(undefined); onClose() }}>
            {t('git.genModelDefault')}{current === undefined ? ' ✓' : ''}
          </button>
          {models.map(model => (
            <button
              key={`${model.provider}/${model.model}`}
              className={css.menuItem}
              title={`${model.provider} / ${model.model}`}
              onClick={() => { onPick(`${model.provider}/${model.model}`); onClose() }}
            >
              {model.name || model.model} ({model.provider}){current === `${model.provider}/${model.model}` ? ' ✓' : ''}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
