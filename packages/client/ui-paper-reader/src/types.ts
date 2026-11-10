/**
 * Shapes exchanged between the paper library's host routes and its browser
 * half. Geometry is normalized to the page box so a highlight survives zoom,
 * fit-width, and device-pixel changes.
 */

/** One highlight rectangle as fractions of its page's width and height. */
export interface PaperRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One persisted highlight, optionally carrying the note the reader attached. */
export interface PaperAnnotation {
  readonly id: string
  /** One-based page number in the document. */
  readonly page: number
  /** Every line box the selection covered, in reading order. */
  readonly rects: readonly PaperRect[]
  /** The selected text, kept so a highlight can be read back without the PDF. */
  readonly text: string
  readonly note?: string
  readonly createdAt: string
}

/** A paper as the library lists it. */
export interface PaperSummary {
  readonly id: string
  readonly name: string
  /** Uploaded byte count. */
  readonly size: number
  readonly addedAt: string
  readonly annotationCount: number
}

/** A paper with its annotations, as one open reader sees it. */
export interface PaperRecord extends PaperSummary {
  readonly annotations: readonly PaperAnnotation[]
}

/** The subset of a record the library persists beside the PDF. */
export interface PaperDocument {
  readonly name: string
  readonly size: number
  readonly addedAt: string
  readonly annotations: readonly PaperAnnotation[]
}

/** The annotations document a reader writes back. */
export interface PaperAnnotationsUpdate {
  readonly annotations: readonly PaperAnnotation[]
}

/** Languages the reader can translate a selection or a page into. */
export type PaperTranslateTarget = 'zh' | 'en'

/** One translation request from the reader. */
export interface PaperTranslateRequest {
  /** Text to translate; the host bounds it before calling a model. */
  readonly text: string
  /** Language the translation is written in. */
  readonly target: PaperTranslateTarget
}

/** One NDJSON line of a translation response, in arrival order. */
export type PaperTranslateEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'finish' }
  /** Sent after deltas only when the stream failed once text was already printed. */
  | { readonly type: 'error'; readonly message: string }
