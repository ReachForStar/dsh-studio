/** Whole-document text extraction: PDF.js items joined in reading order. */
import { describe, expect, it } from 'vitest'
import type { PDFPageProxy } from 'pdfjs-dist'
import { extractPageText } from '../src/client/pdf/extract.ts'

/** A page exposing the text content the extractor reads. */
function pageOf(items: readonly unknown[]): PDFPageProxy {
  return { getTextContent: async () => ({ items }) } as unknown as PDFPageProxy
}

describe('extractPageText', () => {
  it('joins items with spaces and keeps PDF.js line breaks', async () => {
    const page = pageOf([
      { str: 'Hello' }, { str: 'world', hasEOL: true }, { str: 'next' },
    ])
    expect(await extractPageText(page)).toBe('Hello world\nnext')
  })

  it('skips marked-content entries and trims trailing whitespace', async () => {
    const page = pageOf([
      { type: 'beginMarkedContent' },
      { str: 'only' },
      { str: '', hasEOL: true },
    ])
    expect(await extractPageText(page)).toBe('only')
  })

  it('returns an empty string for a page without text', async () => {
    expect(await extractPageText(pageOf([]))).toBe('')
  })
})
