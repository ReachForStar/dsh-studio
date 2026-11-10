/** Plain-text extraction for whole-document translation. */
import type { PDFPageProxy } from 'pdfjs-dist'

/**
 * Extract one page's text in reading order, keeping PDF.js line breaks so
 * paragraphs survive the translation prompt.
 * @param page - the loaded PDF page.
 * @returns the page's text, without trailing whitespace.
 */
export async function extractPageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent()
  const parts: string[] = []
  for (const item of content.items) {
    // Marked-content entries carry no text; skipping them keeps real spacing.
    if (!('str' in item)) continue
    parts.push(item.str)
    parts.push(item.hasEOL ? '\n' : ' ')
  }
  return parts.join('').replace(/[ \t]+\n/gu, '\n').trim()
}
