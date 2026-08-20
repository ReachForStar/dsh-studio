// File panel: a `conversation.view` tab (between the trajectory and Git tabs)
// browsing the workspace repository's directory tree. Selecting a file reads
// its current content through the host's /git/read route into an editable
// textarea; saving writes it back via /git/write — the file is edited in
// place, never handed to a third-party app. Directories expand lazily.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { gitFetch } from './git-client.ts'
import css from './MutationDiffPanel.module.css'

/** Full component props: conversation view share + the ui-polish locale seat. */
export type MutationDiffPanelProps = PropsRuntime<'conversation.view'> & PropsLocale<'ui-polish'>

/** One directory entry from `/git/list`. */
interface DirEntry {
  name: string
  type: 'dir' | 'file'
  path: string
  /** File size in bytes (directories carry null). */
  size: number | null
  /** File modification time as Unix epoch ms (directories carry null). */
  modifiedMs: number | null
}

/** Human-readable file size: 512B / 4.2KB / 1.1MB (one decimal under ten). */
function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024 * 10) / 10}KB`
  return `${Math.round(bytes / (1_024 * 1_024) * 10) / 10}MB`
}

/** Human-readable modification time: HH:MM today, MM-DD HH:MM this year, YYYY-MM-DD otherwise. */
function formatModified(ms: number): string {
  const date = new Date(ms)
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  if (sameDay) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.getFullYear() === now.getFullYear()) {
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} `
      + `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * A compact type glyph for one file, based on its extension. SVG-free (no
 * emoji-as-icon per ui-ux-pro-max): single-character typographic markers the
 * monospace theme renders crisply.
 */
function fileGlyph(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'ƒ'
  const ext = name.slice(dot + 1).toLowerCase()
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'J'
  if (ext === 'json' || ext === 'yaml' || ext === 'yml' || ext === 'toml' || ext === 'lock') return '{'
  if (ext === 'md' || ext === 'txt' || ext === 'rst') return 'M'
  if (ext === 'css' || ext === 'scss' || ext === 'less' || ext === 'html' || ext === 'vue' || ext === 'svelte') return '#'
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp' || ext === 'svg') return '▨'
  if (ext === 'py' || ext === 'sh' || ext === 'bash' || ext === 'ps1') return '>'
  if (ext === 'yml' || ext === 'yaml') return '≋'
  return 'ƒ'
}

/** The workspace path owning the current session, if any. */
function workspacePathOf(
  sessionId: string | undefined,
  items: readonly WorkspaceListState['items'][number][],
): string | undefined {
  if (sessionId === undefined) return undefined
  return items.find(item => item.sessionIds.includes(sessionId as never))?.path
}

/**
 * Render the file panel as a conversation view tab browsing the workspace tree.
 * @param props - composed slot props.
 * @returns the panel element tree.
 */
export function MutationDiffPanel({ useSession, useWorkspaces, t }: MutationDiffPanelProps) {
  const sessionId = useSession(s => s.sessionId)
  const workspaceItems = useWorkspaces(s => s.items)
  const cwd = workspacePathOf(sessionId, workspaceItems)
  const [rootItems, setRootItems] = useState<readonly DirEntry[] | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [children, setChildren] = useState<Record<string, readonly DirEntry[]>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  /** Data URL for an image file preview (read-only; images are not editable). */
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load the workspace root listing on mount / workspace switch.
  useEffect(() => {
    setRootItems(null)
    setExpanded(new Set())
    setChildren({})
    setSelected(null)
    setContent(null)
    setImageDataUrl(null)
    if (cwd === undefined) return
    let cancelled = false
    gitFetch<{ items: DirEntry[] }>('/git/list', cwd, { method: 'POST', body: JSON.stringify({}) })
      .then((result) => { if (!cancelled) setRootItems(result.items) })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [cwd])

  const toggleDir = useCallback(async (path: string): Promise<void> => {
    if (cwd === undefined) return
    const next = new Set(expanded)
    if (next.has(path)) {
      next.delete(path)
      setExpanded(next)
      return
    }
    // Expand: fetch children (once), then mark expanded.
    next.add(path)
    setExpanded(next)
    if (children[path] !== undefined) return
    try {
      const result = await gitFetch<{ items: DirEntry[] }>('/git/list', cwd, {
        method: 'POST',
        body: JSON.stringify({ dir: path }),
      })
      setChildren(prev => ({ ...prev, [path]: result.items }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [cwd, expanded, children])

  const openFile = useCallback(async (path: string): Promise<void> => {
    if (cwd === undefined) return
    setSelected(path)
    setContent(null)
    setImageDataUrl(null)
    setError(null)
    try {
      const result = await gitFetch<{ content?: string; isImage?: boolean; dataUrl?: string }>('/git/read', cwd, {
        method: 'POST',
        body: JSON.stringify({ path }),
      })
      if (result.isImage === true && result.dataUrl !== undefined) {
        setImageDataUrl(result.dataUrl)
        return
      }
      setContent(result.content ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [cwd])

  const saveFile = async (): Promise<void> => {
    if (cwd === undefined || selected === null || content === null) return
    setBusy(true)
    setError(null)
    try {
      await gitFetch('/git/write', cwd, {
        method: 'POST',
        body: JSON.stringify({ path: selected, content }),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** Render one entry; directories recurse into their fetched children. */
  const renderEntry = (entry: DirEntry): ReactNode => {
    if (entry.type === 'dir') {
      const open = expanded.has(entry.path)
      const kids = children[entry.path]
      return (
        <li key={entry.path}>
          <button
            type="button" className={css.dir}
            aria-expanded={open}
            onClick={() => { void toggleDir(entry.path) }}
          >
            <span className={css.dirArrow} aria-hidden>{open ? '▾' : '▸'}</span>
            <span className={css.dirGlyph} aria-hidden>▤</span>
            <span className={css.filePath}>{entry.name}/</span>
          </button>
          {open && (
            <ul className={css.nested}>
              {kids === undefined
                ? <li className={css.notice}>…</li>
                : kids.map(kid => renderEntry(kid))}
            </ul>
          )}
        </li>
      )
    }
    return (
      <li key={entry.path}>
        <button
          type="button"
          className={selected === entry.path ? css.fileSelected : css.file}
          onClick={() => { void openFile(entry.path) }}
        >
          <span className={css.fileGlyph} aria-hidden>{fileGlyph(entry.name)}</span>
          <span className={css.filePath}>{entry.name}</span>
          {entry.size !== null && (
            <span className={css.fileMeta}>
              {formatSize(entry.size)}
              {entry.modifiedMs !== null && ` · ${formatModified(entry.modifiedMs)}`}
            </span>
          )}
        </button>
      </li>
    )
  }

  /** Reload the workspace root listing. */
  const refresh = useCallback((): void => {
    if (cwd === undefined) return
    setError(null)
    gitFetch<{ items: DirEntry[] }>('/git/list', cwd, { method: 'POST', body: JSON.stringify({}) })
      .then((result) =>{  setRootItems(result.items) })
      .catch((e: unknown) =>{  setError(e instanceof Error ? e.message : String(e)) })
  }, [cwd])

  return (
    <div className={css.view} data-ui-polish-diff="">
      <div className={css.viewHeader}>
        <span className={css.title}>{t('diff.title')}</span>
        {cwd !== undefined && <span className={css.cwd}>{cwd}</span>}
        {cwd !== undefined && (
          <button type="button" className={css.refresh} onClick={() => {  refresh() }}>
            {t('diff.refresh')}
          </button>
        )}
      </div>
      {cwd === undefined
        ? <div className={css.notice}>{t('git.noWorkspace')}</div>
        : (
          <div className={css.columns}>
            <div className={css.column}>
              {error !== null && <div className={css.error}>{error}</div>}
              {rootItems === null
                ? <div className={css.notice}>…</div>
                : rootItems.length === 0
                  ? <div className={css.notice}>{t('diff.empty')}</div>
                  : (
                    <ul className={css.files}>
                      {rootItems.map(entry => renderEntry(entry))}
                    </ul>
                  )}
            </div>
            <div className={css.column}>
              {selected === null
                ? <div className={css.notice}>{t('diff.select')}</div>
                : imageDataUrl !== null
                  ? (
                    <>
                      <div className={css.fileHeader}>
                        <span className={css.filePath}>{selected}</span>
                        <span className={css.previewTag}>{t('diff.preview')}</span>
                      </div>
                      <div className={css.imageWrap}>
                        <img className={css.image} src={imageDataUrl} alt={selected} />
                      </div>
                    </>
                  )
                  : (
                    <>
                      <div className={css.fileHeader}>
                        <span className={css.filePath}>{selected}</span>
                        <button
                          type="button" className={css.action}
                          disabled={busy || content === null}
                          onClick={() => { void saveFile() }}
                        >
                          {t('diff.save')}
                        </button>
                      </div>
                      {content === null
                        ? <div className={css.notice}>…</div>
                        : (
                          <textarea
                            className={css.editor}
                            value={content}
                            spellCheck={false}
                            onChange={(event) => { setContent(event.target.value) }}
                          />
                        )}
                    </>
                  )}
            </div>
          </div>
        )}
    </div>
  )
}
