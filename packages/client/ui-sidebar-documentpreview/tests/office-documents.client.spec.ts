// @vitest-environment jsdom
/** Word 与 PowerPoint 的解析/重组：段落与文本框文本、其余部件原样保留、计数校验。 */
import { describe, expect, it } from 'vitest'
import { parseDocx } from '../src/client/office/docx.ts'
import { parsePptx } from '../src/client/office/pptx.ts'
import { setXmlPart, unzipParts, zipParts } from '../src/client/office/zip.ts'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes ?? new Uint8Array())

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const DOCUMENT_XML = `<w:document xmlns:w="${W}"><w:body>`
  + '<w:p><w:r><w:t>first</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>second</w:t></w:r><w:r><w:t> half</w:t></w:r></w:p>'
  + '</w:body></w:document>'

function docxBytes(xml = DOCUMENT_XML): Uint8Array {
  const parts = {
    '[Content_Types].xml': encode('<Types/>'),
    'word/document.xml': encode(xml),
    'word/styles.xml': encode('<styles/>'),
  }
  return zipParts(parts)
}

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const slide = (texts: readonly string[]): string => `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld>`
  + texts.map(text => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')
  + '</p:cSld></p:sld>'

function pptxBytes(): Uint8Array {
  return zipParts({
    'ppt/slides/slide2.xml': encode(slide(['second slide'])),
    'ppt/slides/slide10.xml': encode(slide(['ten A', 'ten B'])),
    'ppt/presentation.xml': encode('<p:presentation/>'),
  })
}

describe('parseDocx', () => {
  it('reads one entry per paragraph, joining runs', () => {
    expect(parseDocx(docxBytes()).paragraphs).toEqual(['first', 'second half'])
  })

  it('writes edited text back and leaves every other part untouched', () => {
    const edited = parseDocx(docxBytes()).rebuild(['changed', 'also changed'])
    const parts = unzipParts(edited)

    expect(decode(parts['word/document.xml'])).toContain('changed')
    expect(decode(parts['word/document.xml'])).toContain('also changed')
    expect(decode(parts['word/document.xml'])).not.toContain('first')
    expect(decode(parts['word/styles.xml'])).toBe('<styles/>')
    expect(decode(parts['[Content_Types].xml'])).toBe('<Types/>')
    expect(parseDocx(edited).paragraphs).toEqual(['changed', 'also changed'])
  })

  it('refuses a paragraph count that does not match the document', () => {
    expect(() => parseDocx(docxBytes()).rebuild(['only one'])).toThrow(/docx: the document has 2 paragraph\(s\); 1 were supplied/)
  })

  it('refuses an archive without the document part', () => {
    expect(() => parseDocx(zipParts({ 'word/styles.xml': encode('<styles/>') })))
      .toThrow(/docx: the archive has no word\/document\.xml/)
  })
})

describe('parsePptx', () => {
  it('orders slides numerically and reads each slide\'s texts', () => {
    expect(parsePptx(pptxBytes()).slides).toEqual([
      { part: 'ppt/slides/slide2.xml', texts: ['second slide'] },
      { part: 'ppt/slides/slide10.xml', texts: ['ten A', 'ten B'] },
    ])
  })

  it('writes edited slide text back and repacks every part', () => {
    const edited = parsePptx(pptxBytes()).rebuild([['edited two'], ['edited ten A', 'edited ten B']])
    const parts = unzipParts(edited)

    expect(decode(parts['ppt/slides/slide2.xml'])).toContain('edited two')
    expect(decode(parts['ppt/slides/slide10.xml'])).toContain('edited ten A')
    expect(decode(parts['ppt/slides/slide10.xml'])).toContain('edited ten B')
    expect(parsePptx(edited).slides.map(entry => entry.texts)).toEqual([['edited two'], ['edited ten A', 'edited ten B']])
  })

  it('refuses a slide or text count that does not match the deck', () => {
    const deck = parsePptx(pptxBytes())
    expect(() => deck.rebuild([[]])).toThrow(/pptx: the deck has 2 slide\(s\); 1 were supplied/)
    expect(() => deck.rebuild([['a'], ['b']]))
      .toThrow(/pptx: ppt\/slides\/slide10\.xml holds 2 text\(s\); 1 were supplied/)
  })

  it('reads a deck with no slides as an empty document', () => {
    const empty = parsePptx(zipParts({ 'ppt/presentation.xml': encode('<p:presentation/>') }))
    expect(empty.slides).toEqual([])
    expect(empty.rebuild([])).toBeInstanceOf(Uint8Array)
  })

  it('refuses a malformed slide part', () => {
    const parts = { 'ppt/slides/slide1.xml': encode('<p:sld>') }
    expect(() => parsePptx(zipParts(parts))).toThrow(/pptx: the XML part could not be parsed/)
  })

  it('ignores non-slide parts and rewrites only the slides', () => {
    const bytes = pptxBytes()
    const parts = unzipParts(bytes)
    setXmlPart(parts, 'ppt/notesSlides/notesSlide1.xml', '<notes/>')
    const edited = parsePptx(zipParts(parts)).rebuild([['one'], ['two', 'three']])
    expect(decode(unzipParts(edited)['ppt/notesSlides/notesSlide1.xml'])).toBe('<notes/>')
  })
})
