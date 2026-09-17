// @vitest-environment jsdom
/** 办公室文档的 zip 与 XML 基元：解压/压缩往返、按局部名查找、文本替换。 */
import { describe, expect, it } from 'vitest'
import { messageOf } from '../src/client/office/errors.ts'
import { parseXml, serializeXml, elementsNamed, setTextOf, textOf } from '../src/client/office/xml.ts'
import { setXmlPart, unzipParts, xmlPart, zipParts } from '../src/client/office/zip.ts'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('office zip', () => {
  it('packs and unpacks parts unchanged', () => {
    const parts = { 'a.xml': encode('<a/>'), 'dir/b.xml': encode('<b/>') }
    const packed = zipParts(parts)
    const unpacked = unzipParts(packed)
    expect(Object.keys(unpacked).sort()).toEqual(['a.xml', 'dir/b.xml'])
    expect(new TextDecoder().decode(unpacked['a.xml'] ?? new Uint8Array())).toBe('<a/>')
  })

  it('decodes one part and refuses an absent one', () => {
    const parts = { 'a.xml': encode('<a/>') }
    expect(xmlPart(parts, 'a.xml', 'docx')).toBe('<a/>')
    expect(() => xmlPart(parts, 'missing.xml', 'docx')).toThrow(/docx: the archive has no missing\.xml/)
  })

  it('replaces one part in place', () => {
    const parts = { 'a.xml': encode('<a/>') }
    setXmlPart(parts, 'a.xml', '<a changed="1"/>')
    expect(new TextDecoder().decode(parts['a.xml'] ?? new Uint8Array())).toBe('<a changed="1"/>')
  })
})

describe('office xml', () => {
  const PARTS = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">hello</w:t></w:r><w:r><w:t> world</w:t></w:r></w:p></w:body></w:document>'

  it('parses a document and refuses malformed XML', () => {
    expect(parseXml(PARTS, 'docx').documentElement.localName).toBe('document')
    expect(() => parseXml('<w:document><w:body>', 'docx')).toThrow(/docx: the XML part could not be parsed/)
  })

  it('finds elements by local name regardless of the prefix', () => {
    const doc = parseXml(PARTS, 'docx')
    expect(elementsNamed(doc, 't')).toHaveLength(2)
    expect(elementsNamed(doc.documentElement, 'p')).toHaveLength(1)
    expect(elementsNamed(doc, 'nothing')).toEqual([])
  })

  it('reads the concatenated text of a container', () => {
    const doc = parseXml(PARTS, 'docx')
    expect(textOf(elementsNamed(doc, 'p')[0] as Element, 't')).toBe('hello world')
  })

  it('keeps the first leaf, empties the rest, and preserves spaces', () => {
    const doc = parseXml(PARTS, 'docx')
    const paragraph = elementsNamed(doc, 'p')[0] as Element
    setTextOf(paragraph, 't', 'changed')
    const leaves = elementsNamed(paragraph, 't')
    expect(leaves.map(leaf => leaf.textContent)).toEqual(['changed', ''])
    expect(leaves[0]?.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space')).toBe('preserve')
    expect(serializeXml(doc)).toContain('changed')
  })
})

describe('messageOf', () => {
  it('reads an Error message and stringifies anything else', () => {
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf('plain failure')).toBe('plain failure')
  })
})
