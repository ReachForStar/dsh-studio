/**
 * The paper reader page: the stored library, one open paper with selectable
 * text, and the floating menu a text selection opens.
 *
 * Nothing here reaches into the Sidebar: the page is a tab type registered by
 * `index.ts`, and the only Session seat it reads is the standard `inputActions`
 * face, which fills the composer draft without submitting.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronLeftOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaperAnnotation, PaperRecord, PaperSummary } from '../types.ts'
import {
  deletePaper, listPapers, readPaper, readPaperBytes, uploadPaper, writeAnnotations,
} from './paper-api.ts'
import { PdfViewer } from './PdfViewer.tsx'
import css from './PaperReader.module.css'

/** Props of the paper reader page. */
export type PaperReaderTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'paperReader'>

/** Which of the page's two views is on screen. */
type PaperReaderView =
  | { readonly kind: 'library' }
  | { readonly kind: 'reader'; readonly id: string }

/**
 * Render the library, or the paper the reader opened from it.
 * @param props - localized copy and the Session's composer input actions.
 * @returns the current view.
 */
export function PaperReaderTab(props: PaperReaderTabProps): ReactNode {
  const { t, inputActions } = props
  const [view, setView] = useState<PaperReaderView>({ kind: 'library' })
  const open = useCallback((id: string): void => { setView({ kind: 'reader', id }) }, [])
  const back = useCallback((): void => { setView({ kind: 'library' }) }, [])
  // Insert at the caret instead of replacing the draft, so an unsent question
  // the user already typed survives.
  const ask = useCallback((text: string): boolean => {
    const span = inputActions.captureInsertion()
    if (!inputActions.insertText(`${t('askPrompt')}\n\n`, span)) return false
    return inputActions.insertQuote(text)
  }, [inputActions, t])
  return (
    <div className={css.page}>
      {view.kind === 'library'
        ? <PaperLibrary t={t} onOpen={open} />
        : <PaperView key={view.id} paperId={view.id} t={t} ask={ask} onBack={back} />}
    </div>
  )
}

/** The stored papers, with upload, refresh, open, and delete. */
function PaperLibrary(props: {
  readonly t: PropsLocale<'paperReader'>['t']
  readonly onOpen: (id: string) => void
}): ReactNode {
  const { t, onOpen } = props
  const [papers, setPapers] = useState<readonly PaperSummary[]>()
  const [revision, setRevision] = useState(0)
  const [listFailed, setListFailed] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadFailed, setUploadFailed] = useState(false)
  const [deleteFailed, setDeleteFailed] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const lifetime = new AbortController()
    setListFailed(false)
    void listPapers(lifetime.signal).then(
      (next) => { if (!lifetime.signal.aborted) setPapers(next) },
      () => { if (!lifetime.signal.aborted) setListFailed(true) },
    )
    return () => { lifetime.abort() }
  }, [revision])

  const upload = (chosen: File): void => {
    setUploading(true)
    setUploadFailed(false)
    void uploadPaper(chosen, new AbortController().signal).then(
      (record) => {
        setUploading(false)
        setPapers(current => current === undefined ? current : [record, ...current])
      },
      () => { setUploading(false); setUploadFailed(true) },
    )
  }

  const remove = (id: string): void => {
    setDeleteFailed(false)
    void deletePaper(id, new AbortController().signal).then(
      () => { setPapers(current => current?.filter(paper => paper.id !== id)) },
      () => { setDeleteFailed(true) },
    )
  }

  return (
    <>
      <header className={css.header}>
        <button type="button" className={css.action} disabled={uploading}
          onClick={() => { picker.current?.click() }}>
          <IconPlusOutlineRegular size={14} />
          {uploading ? t('uploading') : t('upload')}
        </button>
        <button type="button" className={css.action} aria-label={t('refresh')}
          onClick={() => { setRevision(value => value + 1) }}>
          <IconRefreshOutlineRegular size={14} />
        </button>
        <input ref={picker} className={css.picker} type="file" accept="application/pdf" hidden
          onChange={(event) => {
            const chosen = event.target.files?.[0]
            event.target.value = ''
            if (chosen !== undefined) upload(chosen)
          }} />
      </header>
      <div className={css.scroll}>
        {uploadFailed ? <p className={css.notice} role="alert">{t('uploadFailed')}</p> : undefined}
        {deleteFailed ? <p className={css.notice} role="alert">{t('deleteFailed')}</p> : undefined}
        {listFailed
          ? <p className={css.notice} role="alert">
            {t('listFailed')}
            <button type="button" className={css.inlineAction}
              onClick={() => { setRevision(value => value + 1) }}>{t('retry')}</button>
          </p>
          : papers === undefined
            ? <p className={css.notice} role="status">{t('loading')}</p>
            : papers.length === 0
              ? <p className={css.notice}>{t('emptyLibrary')}</p>
              : <ul className={css.list}>
                {papers.map(paper => (
                  <li key={paper.id} className={css.row}>
                    <button type="button" className={css.rowOpen} aria-label={t('openPaper', { name: paper.name })}
                      onClick={() => { onOpen(paper.id) }}>
                      <span className={css.rowName}>{paper.name}</span>
                      <span className={css.rowMeta}>
                        {formatSize(paper.size)}
                        {paper.annotationCount === 0
                          ? undefined
                          : <> · {t('annotationCount', { count: paper.annotationCount })}</>}
                      </span>
                    </button>
                    <button type="button" className={css.rowRemove} aria-label={t('deletePaper')}
                      onClick={() => { remove(paper.id) }}>
                      <IconTrashOutlineRegular size={14} />
                    </button>
                  </li>
                ))}
              </ul>}
      </div>
    </>
  )
}

/** One open paper: its bytes, its annotations, and the way back to the library. */
function PaperView(props: {
  readonly paperId: string
  readonly t: PropsLocale<'paperReader'>['t']
  readonly ask: (text: string) => boolean
  readonly onBack: () => void
}): ReactNode {
  const { paperId, t, ask, onBack } = props
  const [lifetime] = useState(() => new AbortController())
  const [loaded, setLoaded] = useState<{ readonly record: PaperRecord; readonly data: Uint8Array<ArrayBuffer> }>()
  const [failed, setFailed] = useState(false)
  const [annotations, setAnnotations] = useState<readonly PaperAnnotation[]>([])
  const [saveFailed, setSaveFailed] = useState(false)

  useEffect(() => () => { lifetime.abort() }, [lifetime])

  useEffect(() => {
    void (async () => {
      const record = await readPaper(paperId, lifetime.signal)
      const data = await readPaperBytes(paperId, lifetime.signal)
      if (lifetime.signal.aborted) return
      setAnnotations(record.annotations)
      setLoaded({ record, data })
    })().catch(() => { if (!lifetime.signal.aborted) setFailed(true) })
  }, [paperId, lifetime])

  // The local list is what the reader edits; every change rewrites the whole
  // document, so a write that fails is corrected by the next successful one.
  const persist = useCallback((next: readonly PaperAnnotation[]): void => {
    setAnnotations(next)
    setSaveFailed(false)
    void writeAnnotations(paperId, next, lifetime.signal).catch(() => {
      if (!lifetime.signal.aborted) setSaveFailed(true)
    })
  }, [paperId, lifetime])

  const create = useCallback((annotation: PaperAnnotation): void => {
    persist([...annotations, annotation])
  }, [annotations, persist])

  const remove = useCallback((id: string): void => {
    persist(annotations.filter(annotation => annotation.id !== id))
  }, [annotations, persist])

  return (
    <>
      <header className={css.header}>
        <button type="button" className={css.action} onClick={onBack}>
          <IconChevronLeftOutlineRegular size={14} />
          {t('back')}
        </button>
        <span className={css.headerTitle}>{loaded?.record.name}</span>
      </header>
      {saveFailed ? <p className={css.notice} role="alert">{t('annotationFailed')}</p> : undefined}
      {failed
        ? <p className={css.notice} role="alert">{t('loadFailed')}</p>
        : loaded === undefined
          ? <p className={css.notice} role="status">{t('loading')}</p>
          : <PdfViewer data={loaded.data} annotations={annotations} signal={lifetime.signal} t={t}
            ask={ask} onCreate={create} onRemove={remove} />}
    </>
  )
}

/**
 * Format a byte count for a library row.
 * @param bytes - stored size.
 * @returns a short human-readable size.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
