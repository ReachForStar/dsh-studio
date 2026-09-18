/**
 * The PowerPoint body: a `.pptx`'s slide texts, shown or edited in place.
 *
 * A slide's text leaves are edited as a group, because that is what the save
 * replaces: the shape, position, theme, images and speaker notes of every
 * slide stay as the producer wrote them. Content that is not a complete deck,
 * and a deck that cannot be parsed, each get their own line instead of an
 * empty body.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { parsePptx } from '../office/pptx.ts'
import { OfficeEditor } from '../office/OfficeEditor.tsx'
import type {} from './locales.ts'
import css from '../office/OfficeEditor.module.css'

/** Standard document props plus the PowerPoint renderer's dictionary. */
export type PptxBodyProps = DocumentPreviewProps & PropsLocale<'sidebarPptx'>

/** What the bytes turned out to be: a parsed deck, or the reason there is none. */
type PptxView =
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly texts: readonly (readonly string[])[]; readonly rebuild: (slides: readonly (readonly string[])[]) => Uint8Array }

/**
 * Present a presentation's slides.
 * @param props - document bytes, the tab's save callback, and locale.
 * @returns the slides, editable in place.
 */
export function PptxBody({ content, t, saveBytes, saving, saveFailure }: PptxBodyProps): ReactNode {
  const data = content.kind === 'bytes' ? content.data : undefined
  const view = useMemo((): PptxView => {
    if (data === undefined) return { kind: 'unsupported' }
    try {
      const document = parsePptx(data)
      return { kind: 'ready', texts: document.slides.map(slide => slide.texts), rebuild: document.rebuild }
    } catch {
      // The copy says a presentation could not be opened; the dependency's
      // message names a zip or XML internal a reader cannot act on.
      return { kind: 'failed' }
    }
  }, [data])
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<readonly (readonly string[])[]>([])
  // What the file is known to hold: the parsed texts, and after a save the
  // texts that were written.
  const [baseline, setBaseline] = useState<readonly (readonly string[])[]>([])

  useEffect(() => {
    if (view.kind !== 'ready') return
    setDrafts(view.texts)
    setBaseline(view.texts)
  }, [view])

  if (view.kind === 'unsupported') return <p className={css.error} role="alert">{t('unsupported')}</p>
  if (view.kind === 'failed') return <p className={css.error} role="alert">{t('failed')}</p>

  return (
    <OfficeEditor
      blocks={drafts.map((lines, index) => ({ heading: t('slide', { index: index + 1 }), texts: lines }))}
      editing={editing}
      onEditing={setEditing}
      onDraft={setDrafts}
      dirty={drafts.some((lines, index) => lines.some((line, textIndex) => line !== baseline[index]?.[textIndex]))}
      saving={saving}
      failure={saveFailure}
      copy={{
        edit: t('edit'), stopEdit: t('stopEdit'), save: t('save'),
        saving: t('saving'), unsaved: t('unsaved'), failed: t('failed'),
      }}
      onSave={() => {
        // The pane owns the write and its status; this editor only has to know
        // that the text it sent is what the file now holds.
        saveBytes(view.rebuild(drafts.map(lines => [...lines])))
        setBaseline(drafts)
      }}
    />
  )
}
