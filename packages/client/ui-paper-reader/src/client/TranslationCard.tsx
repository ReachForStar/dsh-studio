/**
 * The translation result card: streamed text for one selection or the whole
 * document, with the target-language switch, a copy action, and a close action.
 */
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { IconCloseOutlineRegular, useClipboardCopy } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaperTranslateTarget } from '../types.ts'
import css from './PdfViewer.module.css'

/** What the card shows; the viewer owns the lifecycle and updates it in place. */
export interface TranslationView {
  /** A selected passage, or every page's text. */
  readonly kind: 'selection' | 'document'
  /** Language the current text is written in. */
  readonly target: PaperTranslateTarget
  /** Text received so far. */
  readonly text: string
  readonly status: 'streaming' | 'ready' | 'failed' | 'empty'
  /** Pages finished, for a document translation. */
  readonly done: number
  /** Pages submitted, for a document translation. */
  readonly total: number
}

/** Props of the translation card. */
export interface TranslationCardProps {
  readonly view: TranslationView
  readonly t: TranslateNS<'paperReader'>
  /** Translate the same source again into another language. */
  readonly onTarget: (target: PaperTranslateTarget) => void
  /** Cancel an unfinished translation and take the card down. */
  readonly onClose: () => void
}

/**
 * Render one translation.
 * @param props - the current view, copy seat, and the two actions.
 * @returns the card.
 */
export function TranslationCard({ view, t, onTarget, onClose }: TranslationCardProps): ReactNode {
  const { copied, onCopy } = useClipboardCopy(view.text)
  return (
    <aside className={css.translation} aria-label={t('translateCard')} data-paper-translation>
      <header className={css.translationHeader}>
        <h3 className={css.translationTitle}>
          {view.kind === 'selection' ? t('translateSelectionTitle') : t('translateDocumentTitle')}
        </h3>
        <div className={css.translationActions}>
          <button type="button" className={css.translationToggle} aria-pressed={view.target === 'zh'}
            onClick={() => { onTarget('zh') }}>
            {t('translateTargetZh')}
          </button>
          <button type="button" className={css.translationToggle} aria-pressed={view.target === 'en'}
            onClick={() => { onTarget('en') }}>
            {t('translateTargetEn')}
          </button>
          <button type="button" className={css.translationAction} disabled={view.text === ''} onClick={onCopy}>
            {copied ? t('translateCopied') : t('translateCopy')}
          </button>
          <button type="button" className={css.translationAction} aria-label={t('translateClose')}
            onClick={onClose}>
            <IconCloseOutlineRegular size={14} />
          </button>
        </div>
      </header>
      {view.status === 'streaming' && view.text === ''
        ? <p className={css.translationStatus} role="status">{t('translatePending')}</p>
        : undefined}
      {view.status === 'streaming' && view.kind === 'document'
        ? <p className={css.translationStatus} role="status">
          {t('translateProgress', { done: view.done, total: view.total })}
        </p>
        : undefined}
      {view.status === 'failed'
        ? <p className={css.translationNotice} role="alert">{t('translateFailed')}</p>
        : undefined}
      {view.status === 'empty'
        ? <p className={css.translationStatus}>{t('translateEmpty')}</p>
        : undefined}
      {view.text === ''
        ? undefined
        : <div className={css.translationText}>{view.text}</div>}
    </aside>
  )
}
