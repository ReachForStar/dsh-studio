/**
 * The editing chrome both office renderers share: a preview of the parsed
 * blocks, an edit mode with one field per text leaf, and the save status.
 *
 * The parsers own what a document *is*; this component owns only how it is
 * shown and edited, so Word and PowerPoint differ by their block shape and
 * their dictionary, not by a second copy of the save plumbing.
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import css from './OfficeEditor.module.css'

/** One displayed block: a heading and its editable texts, in document order. */
export interface OfficeBlock {
  /** What the block is, shown above its texts (a paragraph index, a slide path). */
  readonly heading: string
  /** The block's text leaves. */
  readonly texts: readonly string[]
}

/** Copy the chrome needs; each format supplies its own namespace's strings. */
export interface OfficeCopy {
  readonly edit: string
  readonly stopEdit: string
  readonly save: string
  readonly saving: string
  readonly unsaved: string
  readonly failed: string
}

/** Props of the shared editing chrome. */
export interface OfficeEditorProps {
  readonly blocks: readonly OfficeBlock[]
  /** Whether the document is being edited; the parent owns the mode. */
  readonly editing: boolean
  readonly onEditing: (next: boolean) => void
  /** Replace every block's text, one array of texts per block. */
  readonly onDraft: (blocks: readonly (readonly string[])[]) => void
  readonly dirty: boolean
  /** A write is in flight, owned by the pane that carries the tab's version. */
  readonly saving: boolean
  /** Failure line for the last refused write, already localized by the pane. */
  readonly failure: string | undefined
  readonly onSave: () => void
  readonly copy: OfficeCopy
}

/** Render one document: read-only text, or the editable fields, plus the toolbar. */
export function OfficeEditor({
  blocks, editing, onEditing, onDraft, dirty, saving, failure, onSave, copy,
}: OfficeEditorProps): ReactNode {
  const status = failure ?? (saving ? copy.saving : dirty ? copy.unsaved : undefined)
  const set = (block: number, text: number, value: string): void => {
    const next = blocks.map((entry, blockIndex) => blockIndex === block
      ? entry.texts.map((line, textIndex) => textIndex === text ? value : line)
      : entry.texts)
    onDraft(next)
  }
  return (
    <div className={css.office} data-office-preview data-office-editing={editing ? '' : undefined}>
      <div className={css.toolbar}>
        <button
          type="button"
          className={clsx(css.tool, editing && css.toolActive)}
          aria-pressed={editing}
          data-office-tool={editing ? 'edit-stop' : 'edit'}
          onClick={() => { onEditing(!editing) }}
        >
          {editing ? copy.stopEdit : copy.edit}
        </button>
        {editing && (
          <button
            type="button"
            className={css.tool}
            disabled={!dirty || saving}
            data-office-save
            onClick={onSave}
          >
            {saving ? copy.saving : copy.save}
          </button>
        )}
        {status !== undefined && <span className={css.status} data-office-status>{status}</span>}
      </div>
      {blocks.map((block, blockIndex) => (
        <section key={block.heading} className={css.block} data-office-block={blockIndex}>
          <h3 className={css.heading}>{block.heading}</h3>
          {editing
            ? block.texts.map((line, textIndex) => (
              <textarea
                key={textIndex}
                className={css.field}
                value={line}
                spellCheck={false}
                aria-label={`${block.heading} ${String(textIndex + 1)}`}
                data-office-field={`${String(blockIndex)}-${String(textIndex)}`}
                onChange={(event) => { set(blockIndex, textIndex, event.target.value) }}
              />
            ))
            : block.texts.map((line, textIndex) => (
              <p key={textIndex} className={css.line} data-office-line={`${String(blockIndex)}-${String(textIndex)}`}>{line}</p>
            ))}
        </section>
      ))}
    </div>
  )
}
