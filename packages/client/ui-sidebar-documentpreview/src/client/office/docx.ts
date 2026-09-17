/**
 * A Word document as editable paragraphs, and the way back to a `.docx`.
 *
 * The preview needs the text of `word/document.xml`; the save needs the same
 * archive with that text replaced and every other part — styles, fonts,
 * images, relationships — untouched. `rebuild` therefore closes over the parts
 * it read, so a caller cannot accidentally save a document stripped of
 * everything this reader does not understand.
 */
import { parseXml, serializeXml, elementsNamed, setTextOf, textOf } from './xml.ts'
import { setXmlPart, unzipParts, xmlPart, zipParts } from './zip.ts'
import type { ZipParts } from './zip.ts'

/** The part holding a Word document's body text. */
const DOCUMENT_PART = 'word/document.xml'

/** One Word document: its paragraphs and the function that writes an edit back. */
export interface DocxDocument {
  /** Paragraph text, one entry per `w:p` in document order. */
  readonly paragraphs: readonly string[]
  /**
   * Rebuild the archive with edited paragraph text.
   * @param paragraphs - replacement text, one entry per paragraph.
   * @returns the complete edited document.
   */
  readonly rebuild: (paragraphs: readonly string[]) => Uint8Array
}

/**
 * Read a Word document's paragraphs.
 * @param bytes - the complete `.docx` archive.
 * @returns the paragraph texts and the rebuild step.
 */
export function parseDocx(bytes: Uint8Array): DocxDocument {
  const parts = unzipParts(bytes)
  const doc = parseXml(xmlPart(parts, DOCUMENT_PART, 'docx'), 'docx')
  const paragraphs = elementsNamed(doc, 'p').map(paragraph => textOf(paragraph, 't'))
  return {
    paragraphs,
    rebuild: next => rebuild(parts, doc, paragraphs.length, next),
  }
}

/** Write edited paragraph text back into the held parts and pack them again. */
function rebuild(parts: ZipParts, doc: XMLDocument, count: number, next: readonly string[]): Uint8Array {
  if (next.length !== count) {
    throw new Error(`docx: the document has ${count} paragraph(s); ${next.length} were supplied`)
  }
  // The count check above is the guarantee: one replacement per paragraph.
  next.forEach((text, index) => {
    setTextOf(elementsNamed(doc, 'p')[index] as Element, 't', text)
  })
  setXmlPart(parts, DOCUMENT_PART, serializeXml(doc))
  return zipParts(parts)
}
