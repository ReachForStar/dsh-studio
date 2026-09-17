/**
 * A PowerPoint deck as editable slide texts, and the way back to a `.pptx`.
 *
 * A slide's text lives in `ppt/slides/slideN.xml` as `a:t` leaves inside
 * shapes. The preview lists those leaves in document order per slide; the save
 * writes the same leaves back and repacks every part, so layout, theme, images
 * and notes stay exactly as the producer wrote them.
 */
import { parseXml, serializeXml, elementsNamed, setTextOf, textOf } from './xml.ts'
import { setXmlPart, unzipParts, xmlPart, zipParts } from './zip.ts'
import type { ZipParts } from './zip.ts'

/** One slide's part path, as the package writes it. */
function slidePath(name: string): boolean {
  return /^ppt\/slides\/slide\d+\.xml$/u.test(name)
}

/** One slide: its text leaves in document order. */
export interface PptxSlide {
  /** The slide's part path, shown as the slide's heading. */
  readonly part: string
  /** Text of each `a:t` leaf, in document order. */
  readonly texts: readonly string[]
}

/** One presentation: its slides and the function that writes an edit back. */
export interface PptxDocument {
  /** Slides in numeric order. */
  readonly slides: readonly PptxSlide[]
  /**
   * Rebuild the archive with edited slide text.
   * @param slides - replacement text, one array per slide, in the same order.
   * @returns the complete edited presentation.
   */
  readonly rebuild: (slides: readonly (readonly string[])[]) => Uint8Array
}

/**
 * Read a presentation's slide texts.
 * @param bytes - the complete `.pptx` archive.
 * @returns the slides and the rebuild step.
 */
export function parsePptx(bytes: Uint8Array): PptxDocument {
  const parts = unzipParts(bytes)
  const paths = Object.keys(parts).filter(name => slidePath(name)).sort(bySlideNumber)
  const documents = paths.map((path) => {
    const doc = parseXml(xmlPart(parts, path, 'pptx'), 'pptx')
    return { path, doc, texts: elementsNamed(doc, 't').map(leaf => textOf(leaf, 't')) }
  })
  return {
    slides: documents.map(({ path, texts }) => ({ part: path, texts })),
    rebuild: next => rebuild(parts, documents, next),
  }
}

/** Numeric slide order: `slide2.xml` precedes `slide10.xml`. */
function bySlideNumber(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true })
}

/** Write edited slide text back into the held parts and pack them again. */
function rebuild(
  parts: ZipParts,
  documents: readonly { readonly path: string; readonly doc: XMLDocument; readonly texts: readonly string[] }[],
  next: readonly (readonly string[])[],
): Uint8Array {
  if (next.length !== documents.length) {
    throw new Error(`pptx: the deck has ${documents.length} slide(s); ${next.length} were supplied`)
  }
  // Both count checks above are the guarantee: one replacement array per
  // slide, and one replacement string per text leaf that slide holds.
  next.forEach((replacement, index) => {
    const { path, doc, texts } = documents[index] as { path: string; doc: XMLDocument; texts: readonly string[] }
    if (replacement.length !== texts.length) {
      throw new Error(`pptx: ${path} holds ${texts.length} text(s); ${replacement.length} were supplied`)
    }
    const leaves = elementsNamed(doc, 't')
    replacement.forEach((text, leafIndex) => {
      setTextOf(leaves[leafIndex] as Element, 't', text)
    })
    setXmlPart(parts, path, serializeXml(doc))
  })
  return zipParts(parts)
}
