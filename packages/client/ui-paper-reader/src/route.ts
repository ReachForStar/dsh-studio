/**
 * The one place the paper library's HTTP surface is named. The host registers
 * the absolute pathname; the browser strips its leading slash because every
 * browser request resolves against the served document.
 */

/** Absolute pathname the host registers the paper library under. */
export const PAPER_READER_ROUTE = '/paper-reader'

/** Document-relative prefix the browser half fetches through. */
export const PAPER_READER_CLIENT_ROUTE = PAPER_READER_ROUTE.slice(1)
