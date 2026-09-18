/**
 * The Word body: a `.docx`'s paragraphs, shown or edited in place.
 *
 * The parse is memoized on the bytes, so a re-render costs nothing and a
 * reload re-reads. Entering edit mode takes a draft of the parsed paragraphs;
 * saving hands the draft to the tab's binary write, which carries the version
 * the tab holds so a document changed underneath is refused rather than
 * overwritten. Content that is not a complete document, and a document that
 * cannot be parsed, each get their own line instead of an empty body.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { parseDocx } from '../office/docx.ts'
import { OfficeEditor } from '../office/OfficeEditor.tsx'
import type {} from './locales.ts'
import css from '../office/OfficeEditor.module.css'

/** Standard document props plus the Word renderer's dictionary. */
export type DocxBodyProps = DocumentPreviewProps & PropsLocale<'sidebarDocx'>

/** What the bytes turned out to be: a parsed document, or the reason there is none. */
type DocxView =
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly paragraphs: readonly string[]; readonly rebuild: (paragraphs: readonly string[]) => Uint8Array }

/**
 * Present a Word document's paragraphs.
 * @param props - document bytes, the tab's save callback, and locale.
 * @returns the paragraphs, editable in place.
 */
export function DocxBody({ content, t, saveBytes, saving, saveFailure }: DocxBodyProps): ReactNode {
  const data = content.kind === 'bytes' ? content.data : undefined
  const view = useMemo((): DocxView => {
    if (data === undefined) return { kind: 'unsupported' }
    try {
      const document = parseDocx(data)
      return { kind: 'ready', paragraphs: document.paragraphs, rebuild: document.rebuild }
    } catch {
      // The copy says a Word document could not be opened; the dependency's
      // message names a zip or XML internal a reader cannot act on.
      return { kind: 'failed' }
    }
  }, [data])
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<readonly string[]>([])
  // What the file is known to hold: the parsed text, and after a save the text
  // that was written. Comparing against it — not against the document the tab
  // first read — is what makes a committed save read as saved.
  const [baseline, setBaseline] = useState<readonly string[]>([])

  // The draft is the parsed document as it stood when it was read; a reloaded
  // document restarts it rather than merging two versions.
  useEffect(() => {
    if (view.kind !== 'ready') return
    setDrafts(view.paragraphs)
    setBaseline(view.paragraphs)
  }, [view])

  if (view.kind === 'unsupported') return <p className={css.error} role="alert">{t('unsupported')}</p>
  if (view.kind === 'failed') return <p className={css.error} role="alert">{t('failed')}</p>

  return (
    <OfficeEditor
      blocks={drafts.map((text, index) => ({ heading: t('paragraph', { index: index + 1 }), texts: [text] }))}
      editing={editing}
      onEditing={setEditing}
      onDraft={(blocks) => { setDrafts(blocks.map(lines => lines.join(''))) }}
      dirty={drafts.some((text, index) => text !== baseline[index])}
      saving={saving}
      failure={saveFailure}
      copy={{
        edit: t('edit'), stopEdit: t('stopEdit'), save: t('save'),
        saving: t('saving'), unsaved: t('unsaved'), failed: t('failed'),
      }}
      onSave={() => {
        // The pane owns the write and its status; this editor only has to know
        // that the text it sent is what the file now holds.
        saveBytes(view.rebuild([...drafts]))
        setBaseline(drafts)
      }}
    />
  )
}
