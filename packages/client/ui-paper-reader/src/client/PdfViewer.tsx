/**
 * The paper surface: PDF.js pages with a selectable text layer, persisted
 * highlight overlays, and the floating menu a text selection opens.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { IconTrashOutlineRegular, MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { PaperAnnotation, PaperRect } from '../types.ts'
import { openPdf, type PdfDocument } from './pdf/runtime.ts'
import { renderPdfPage } from './pdf/render.ts'
import { pdfTextRenderer } from './pdf/text.ts'
import { normalizeRects, overlayStyle } from './selection.ts'
import css from './PdfViewer.module.css'

/** One open selection awaiting a menu action. */
interface SelectionState {
  readonly page: number
  readonly rects: readonly PaperRect[]
  readonly text: string
  readonly x: number
  readonly y: number
}

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly document: PdfDocument }
  | { readonly kind: 'failed' }

/** Everything the viewer needs from its owning page. */
export interface PdfViewerProps {
  readonly data: Uint8Array<ArrayBuffer>
  readonly annotations: readonly PaperAnnotation[]
  readonly signal: AbortSignal
  readonly t: TranslateNS<'paperReader'>
  /** Fill the conversation draft with one question; false when no Session accepts input. */
  readonly ask: (text: string) => boolean
  readonly onCreate: (annotation: PaperAnnotation) => void
  readonly onRemove: (id: string) => void
}

/**
 * Render one paper and its highlights.
 * @param props - bytes, annotations, lifetime, copy, and the selection actions.
 * @returns the page stack and the annotation list.
 */
export function PdfViewer(props: PdfViewerProps): ReactNode {
  const { data, annotations, signal, t, ask, onCreate, onRemove } = props
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [selection, setSelection] = useState<SelectionState>()

  useEffect(() => {
    const lifetime = new AbortController()
    const stopped = AbortSignal.any([lifetime.signal, signal])
    setLoad({ kind: 'loading' })
    const session = openPdf(data, stopped, () => {
      if (!stopped.aborted) setLoad({ kind: 'failed' })
    })
    void session.document.then(
      (document) => { if (!stopped.aborted) setLoad({ kind: 'ready', document }) },
      () => { if (!stopped.aborted) setLoad({ kind: 'failed' }) },
    )
    return () => {
      lifetime.abort()
      void session.dispose()
    }
  }, [data, signal])

  const dismiss = useCallback((): void => {
    setSelection(undefined)
    window.getSelection()?.removeAllRanges()
  }, [])

  useEffect(() => {
    const close = (event: Event): void => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-paper-menu]') !== null) return
      setSelection(undefined)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close(event)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('scroll', close, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', escape)
    }
  }, [])

  const onMouseUp = useCallback((): void => {
    const browserSelection = window.getSelection()
    if (browserSelection === null || browserSelection.isCollapsed || browserSelection.rangeCount === 0) return
    const text = browserSelection.toString().trim()
    if (text === '') return
    const range = browserSelection.getRangeAt(0)
    const start = elementOf(range.startContainer)?.closest<HTMLElement>('[data-paper-page]')
    const end = elementOf(range.endContainer)?.closest<HTMLElement>('[data-paper-page]')
    if (start === null || start === undefined || start !== end) return
    const page = Number(start.dataset.paperPage)
    const surface = start.querySelector<HTMLElement>('[data-paper-surface]')
    if (surface === null || !Number.isInteger(page)) return
    const rects = normalizeRects([...range.getClientRects()], surface.getBoundingClientRect())
    if (rects.length === 0) return
    const last = range.getBoundingClientRect()
    setSelection({ page, rects, text, x: last.left, y: last.bottom + 6 })
  }, [])

  if (load.kind === 'failed') {
    return <p className={css.status} role="alert">{t('loadFailed')}</p>
  }
  if (load.kind === 'loading') {
    return <p className={css.status} role="status">{t('loading')}</p>
  }

  return (
    <div className={css.viewer} onMouseUp={onMouseUp}>
      <div className={css.pages}>
        {Array.from({ length: load.document.numPages }, (_, index) => (
          <PdfPage key={index} document={load.document} page={index + 1} signal={signal} t={t}
            annotations={annotations.filter(annotation => annotation.page === index + 1)} />
        ))}
      </div>
      <section className={css.notes} aria-label={t('annotations')}>
        <h3 className={css.notesTitle}>{t('annotations')}</h3>
        {annotations.length === 0
          ? <p className={css.notesEmpty}>{t('noAnnotations')}</p>
          : <ul className={css.noteList}>
            {annotations.map(annotation => (
              <li key={annotation.id} className={css.note}>
                <span className={css.notePage}>{t('pageLabel', { page: annotation.page })}</span>
                <p className={css.noteQuote}>{annotation.text}</p>
                {annotation.note === undefined
                  ? undefined
                  : <p className={css.noteBody}><span className={css.noteLabel}>{t('noteLabel')}:</span> {annotation.note}</p>}
                <button type="button" className={css.noteRemove} aria-label={t('removeAnnotation')}
                  onClick={() => { onRemove(annotation.id) }}>
                  <IconTrashOutlineRegular />
                </button>
              </li>
            ))}
          </ul>}
      </section>
      {selection === undefined
        ? undefined
        : <SelectionMenu selection={selection} t={t} ask={ask} onCreate={onCreate} onDismiss={dismiss} />}
    </div>
  )
}

/** The floating menu one selection opens, and the note editor it can become. */
function SelectionMenu(props: {
  readonly selection: SelectionState
  readonly t: TranslateNS<'paperReader'>
  readonly ask: (text: string) => boolean
  readonly onCreate: (annotation: PaperAnnotation) => void
  readonly onDismiss: () => void
}): ReactNode {
  const { selection, t, ask, onCreate, onDismiss } = props
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState(false)
  const [askFailed, setAskFailed] = useState(false)

  const highlight = (): void => {
    onCreate(annotationOf(selection, undefined))
    onDismiss()
  }

  const saveNote = (): void => {
    const written = note.trim()
    onCreate(annotationOf(selection, written === '' ? undefined : written))
    onDismiss()
  }

  const askSelection = (): void => {
    if (!ask(selection.text)) {
      setAskFailed(true)
      return
    }
    onDismiss()
  }

  return (
    <MenuSurface className={css.menu} data-paper-menu role="menu" aria-label={t('selectionMenuLabel')}
      style={{ left: selection.x, top: selection.y }}>
      {editing
        ? <div className={css.noteEditor}>
          <textarea className={css.noteInput} value={note} placeholder={t('notePlaceholder')} autoFocus
            onChange={(event) => { setNote(event.target.value) }} />
          <div className={css.menuRow}>
            <button type="button" className={css.menuAction} onClick={saveNote}>{t('saveNote')}</button>
            <button type="button" className={css.menuAction} onClick={onDismiss}>{t('cancel')}</button>
          </div>
        </div>
        : <div className={css.menuRow}>
          <button type="button" className={css.menuAction} role="menuitem" onClick={highlight}>{t('highlight')}</button>
          <button type="button" className={css.menuAction} role="menuitem"
            onClick={() => { setEditing(true) }}>{t('addNote')}</button>
          <button type="button" className={css.menuAction} role="menuitem" onClick={askSelection}>{t('ask')}</button>
        </div>}
      {askFailed ? <p className={css.menuNotice} role="alert">{t('askUnavailable')}</p> : undefined}
    </MenuSurface>
  )
}

/** Build one annotation from the pending selection. */
function annotationOf(selection: SelectionState, note: string | undefined): PaperAnnotation {
  return {
    id: randomUUID(),
    page: selection.page,
    rects: selection.rects,
    text: selection.text,
    createdAt: new Date().toISOString(),
    ...note === undefined ? {} : { note },
  }
}

/** The element a range boundary belongs to, when it has one. */
function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

/** One page: canvas, selectable text overlay, and its persisted highlights. */
function PdfPage(props: {
  readonly document: PdfDocument
  readonly page: number
  readonly signal: AbortSignal
  readonly annotations: readonly PaperAnnotation[]
  readonly t: TranslateNS<'paperReader'>
}): ReactNode {
  const { document, page, signal, annotations, t } = props
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const pageHost = useRef<HTMLDivElement>(null)
  const [requested, setRequested] = useState(page === 1)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const host = pageHost.current
    /* v8 ignore next -- the page div ref binds during commit, before effects run. */
    if (host === null) return
    if (typeof IntersectionObserver === 'undefined') {
      setRequested(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) setRequested(true)
    }, { rootMargin: '100% 0px' })
    observer.observe(host)
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    const node = canvas.current
    const textHost = text.current
    if (!requested || node === null || textHost === null) return
    const lifetime = new AbortController()
    const renderSignal = AbortSignal.any([lifetime.signal, signal])
    setFailed(false)
    let textTask: ReturnType<ReturnType<typeof pdfTextRenderer>> | undefined
    void renderPdfPage(document, page, node, renderSignal, window.devicePixelRatio, (pdfPage, viewport) => {
      textTask = pdfTextRenderer(textHost)(pdfPage, viewport)
      return textTask
    }).then(
      () => { if (!renderSignal.aborted) setReady(true) },
      (error: unknown) => {
        if (renderSignal.aborted) return
        console.error(`[paper-reader] page ${String(page)} failed`, error)
        setFailed(true)
      },
    )
    return () => {
      lifetime.abort()
      textTask?.cancel()
    }
  }, [document, page, requested, signal])

  return (
    <div ref={pageHost} className={css.page} data-paper-page={page}>
      {!ready && <div className={css.placeholder} aria-hidden="true" />}
      {failed && <p className={css.status} role="alert">{t('pageFailed')}</p>}
      <div className={css.surface} data-paper-surface hidden={!ready}>
        {annotations.map(annotation => annotation.rects.map((rect, index) => (
          <span key={`${annotation.id}-${String(index)}`} className={css.highlight} style={overlayStyle(rect)} />
        )))}
        <canvas ref={canvas} className={css.canvas} role="img" aria-label={t('pageLabel', { page })} />
        <div ref={text} className={css.text} data-paper-text />
      </div>
    </div>
  )
}
