// Git panel: a `conversation.view` tab (the top tab ring, right after the
// trajectory tab) showing the workspace repository the browser is currently
// viewing — branch, working-tree changes with per-file diffs, a commit box,
// and a push action. The host exposes `/git/*` routes registered by the node
// half; this component is a plain fetch client carrying the current workspace
// path, so switching workspaces switches the repository. Fetch results are
// cached per workspace path for the panel's lifetime so switching back and
// forth is instant.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { gitFetch } from './git-client.ts'
import css from './GitPanel.module.css'

/** Full component props: conversation view share + the ui-polish locale seat. */
export type GitPanelProps = PropsRuntime<'conversation.view'> & PropsLocale<'ui-polish'>

/** One working-tree file from `/git/status`. */
interface GitStatusEntry {
  status: string
  path: string
}

/** `/git/status` response. */
interface GitStatusResult {
  branch: string
  entries: readonly GitStatusEntry[]
  isRepo: boolean
}

/** `/git/log` response. */
interface GitLogResult {
  commits: readonly string[]
}

/** Per-file view mode: unified diff (default) or the file's live content. */
type FileView = 'diff' | 'content'

/** Two-letter porcelain status → short human label. */
function statusLabel(status: string): string {
  const [index, worktree] = status
  if (index === '?' && worktree === '?') return 'untracked'
  if (index === 'M' || worktree === 'M') return 'modified'
  if (index === 'A') return 'added'
  if (index === 'D' || worktree === 'D') return 'deleted'
  if (index === 'R') return 'renamed'
  return 'changed'
}

/** Whether a status is untracked (a new, un-added file). */
function isUntracked(status: string): boolean {
  return status.startsWith('?')
}

/** The workspace path owning the current session, if any. */
function workspacePathOf(
  sessionId: string | undefined,
  items: readonly WorkspaceListState['items'][number][],
): string | undefined {
  if (sessionId === undefined) return undefined
  return items.find(item => item.sessionIds.includes(sessionId as never))?.path
}

/** Cached fetch payload keyed by workspace path. */
interface GitCache {
  cwd: string
  status: GitStatusResult
  commits: readonly string[]
}

/**
 * Render the git panel as a conversation view tab.
 * @param props - composed slot props.
 * @returns the panel element tree.
 */
export function GitPanel({ useSession, useWorkspaces, t }: GitPanelProps) {
  const sessionId = useSession(s => s.sessionId)
  const workspaceItems = useWorkspaces(s => s.items)
  const cwd = workspacePathOf(sessionId, workspaceItems)
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [commits, setCommits] = useState<readonly string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<FileView>('diff')
  const [diff, setDiff] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const cacheRef = useRef<GitCache | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const [focusIndex, setFocusIndex] = useState(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (cwd === undefined) return
    const cached = cacheRef.current
    if (cached !== null && cached.cwd === cwd) {
      setStatus(cached.status)
      setCommits(cached.commits)
      return
    }
    setError(null)
    try {
      const [statusResult, logResult] = await Promise.all([
        gitFetch<GitStatusResult>('/git/status', cwd),
        gitFetch<GitLogResult>('/git/log', cwd),
      ])
      cacheRef.current = { cwd, status: statusResult, commits: logResult.commits }
      setStatus(statusResult)
      setCommits(logResult.commits)
      setSelected(null)
      setDiff(null)
      setContent(null)
      setFileError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [cwd])

  // Fetch on mount and whenever the workspace path changes (tab switch or
  // workspace switch). Cached results make revisit instant.
  useEffect(() => {
    void refresh()
  }, [refresh])

  const openFile = async (path: string): Promise<void> => {
    if (cwd === undefined) return
    setSelected(path)
    setDiff(null)
    setContent(null)
    setFileError(null)
    try {
      if (view === 'diff') {
        const result = await gitFetch<{ diff: string }>('/git/diff', cwd, {
          method: 'POST',
          body: JSON.stringify({ path }),
        })
        setDiff(result.diff)
      } else {
        const result = await gitFetch<{ content: string }>('/git/read', cwd, {
          method: 'POST',
          body: JSON.stringify({ path }),
        })
        setContent(result.content)
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e))
    }
  }

  const switchView = (next: FileView): void => {
    if (next === view || selected === null) return
    setView(next)
    setDiff(null)
    setContent(null)
    setFileError(null)
    void openFile(selected)
  }

  const saveFile = async (): Promise<void> => {
    if (cwd === undefined || selected === null || content === null) return
    setBusy(true)
    setFileError(null)
    try {
      await gitFetch('/git/write', cwd, {
        method: 'POST',
        body: JSON.stringify({ path: selected, content }),
      })
      cacheRef.current = null
      await refresh()
      setNotice(t('git.saved'))
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    const trimmed = message.trim()
    if (trimmed.length === 0 || cwd === undefined) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await gitFetch('/git/commit', cwd, { method: 'POST', body: JSON.stringify({ message: trimmed }) })
      setMessage('')
      cacheRef.current = null
      await refresh()
      setNotice(t('git.committed'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const push = async (): Promise<void> => {
    if (cwd === undefined) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await gitFetch('/git/push', cwd, { method: 'POST' })
      cacheRef.current = null
      await refresh()
      setNotice(t('git.pushed'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const entries = useMemo(() => status?.entries ?? [], [status])
  const tracked = useMemo(() => entries.filter(entry => !isUntracked(entry.status)), [entries])
  const untracked = useMemo(() => entries.filter(entry => isUntracked(entry.status)), [entries])

  // Keyboard navigation over the file list: arrows move the focus, Enter opens.
  const handleKeyDown = useCallback((event: React.KeyboardEvent): void => {
    const total = entries.length
    if (total === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setFocusIndex(i => (i + 1) % total)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setFocusIndex(i => (i - 1 + total) % total)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const entry = entries[focusIndex]
      if (entry !== undefined) void openFile(entry.path)
    }
  }, [entries, focusIndex, openFile])

  useEffect(() => {
    listRef.current?.querySelectorAll('[data-git-file]')[focusIndex]?.scrollIntoView({ block: 'nearest' })
  }, [focusIndex])

  return (
    <div className={css.view} data-ui-polish-git="">
      <div className={css.viewHeader}>
        <span className={css.title}>{t('git.title')}</span>
        {cwd !== undefined && <span className={css.cwd}>{cwd}</span>}
        {status !== null && status.isRepo && entries.length > 0 && (
          <span className={css.countBadge}>{entries.length}</span>
        )}
        {notice !== null && <span className={css.noticeOk}>{notice}</span>}
      </div>
      {cwd === undefined
        ? <div className={css.notice}>{t('git.noWorkspace')}</div>
        : (
          <>
            {error !== null && <div className={css.error}>{error}</div>}
            {status !== null && !status.isRepo && (
              <div className={css.notice}>{t('git.notRepo')}</div>
            )}
            {status !== null && status.isRepo && (
              <div className={css.columns}>
                <div className={css.column}>
                  <div className={css.branch}>{status.branch}</div>
                  {entries.length === 0
                    ? <div className={css.empty}>{t('git.clean')}</div>
                    : (
                      <ul
                        ref={listRef}
                        className={css.files}
                        onKeyDown={handleKeyDown}
                      >
                        {tracked.length > 0 && tracked.map(entry => (
                          <li key={entry.path}>
                            <button
                              type="button"
                              className={selected === entry.path ? css.fileSelected : css.file}
                              data-git-file=""
                              data-status={statusLabel(entry.status)}
                              onClick={() => { void openFile(entry.path) }}
                            >
                              <span className={css.fileStatus}>{statusLabel(entry.status)}</span>
                              <span className={css.filePath}>{entry.path}</span>
                            </button>
                          </li>
                        ))}
                        {untracked.length > 0 && (
                          <li className={css.groupLabel}>
                            <span className={css.sideTitle}>{t('git.untracked')}</span>
                          </li>
                        )}
                        {untracked.map(entry => (
                          <li key={entry.path}>
                            <button
                              type="button"
                              className={selected === entry.path ? css.fileSelected : css.file}
                              data-git-file=""
                              data-status={statusLabel(entry.status)}
                              onClick={() => { void openFile(entry.path) }}
                            >
                              <span className={css.fileStatus}>{statusLabel(entry.status)}</span>
                              <span className={css.filePath}>{entry.path}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  <div className={css.commitRow}>
                    <input
                      className={css.message}
                      value={message}
                      placeholder={t('git.commitPlaceholder')}
                      onChange={(event) => { setMessage(event.target.value) }}
                      onKeyDown={(event) => { if (event.key === 'Enter') void commit() }}
                    />
                    <button type="button" className={css.action} disabled={busy || message.trim().length === 0} onClick={() => void commit()}>
                      {t('git.commit')}
                    </button>
                    <button type="button" className={css.action} disabled={busy} onClick={() => void push()}>
                      {t('git.push')}
                    </button>
                  </div>
                </div>
                <div className={css.column}>
                  <div className={css.sideTitle}>{t('git.logTitle')}</div>
                  {commits.length > 0 && (
                    <ul className={css.log}>
                      {commits.map(line => <li key={line}>{line}</li>)}
                    </ul>
                  )}
                  {selected !== null && (
                    <>
                      <div className={css.fileHeader}>
                        <span className={css.sideTitle}>{selected}</span>
                        <span className={css.viewSwitch}>
                          <button
                            type="button"
                            className={view === 'diff' ? css.switchActive : css.switch}
                            onClick={() => { switchView('diff') }}
                          >
                            {t('git.diff')}
                          </button>
                          <button
                            type="button"
                            className={view === 'content' ? css.switchActive : css.switch}
                            onClick={() => { switchView('content') }}
                          >
                            {t('git.content')}
                          </button>
                          <button
                            type="button" className={css.action}
                            disabled={busy || content === null}
                            onClick={() => { void saveFile() }}
                          >
                            {t('git.save')}
                          </button>
                        </span>
                      </div>
                      {fileError !== null && <div className={css.error}>{fileError}</div>}
                      {view === 'diff' && (
                        diff === null
                          ? <div className={css.notice}>…</div>
                          : diff.length === 0
                            ? <div className={css.notice}>{t('git.noDiff')}</div>
                            : <pre className={css.diff}>{diff}</pre>
                      )}
                      {view === 'content' && (
                        content === null
                          ? <div className={css.notice}>…</div>
                          : (
                            <textarea
                              className={css.editor}
                              value={content}
                              spellCheck={false}
                              onChange={(event) => { setContent(event.target.value) }}
                            />
                          )
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}
    </div>
  )
}
