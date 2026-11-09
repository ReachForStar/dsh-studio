/** PDF binary resources are exact-name, local data with independent transferable buffers. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPdfBinaryDataFactory, type PdfAssetMap } from '../src/client/pdf/assets.ts'

afterEach(() => { vi.unstubAllGlobals() })

const ASSETS: PdfAssetMap = {
  cMapUrl: { 'sample.bcmap': 'AQID' },
  standardFontDataUrl: { 'font.pfb': 'BAU=' },
  wasmUrl: { 'decoder.wasm': 'BgcI' },
}

describe('createPdfBinaryDataFactory', () => {
  it('reads the ambient build payload when no map is passed', async () => {
    vi.stubGlobal('__DSH_PDFJS_ASSETS__', ASSETS)
    const factory = new (createPdfBinaryDataFactory())()
    expect(Array.from(await factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' }))).toEqual([1, 2, 3])
    expect(Array.from(await factory.fetch({ kind: 'standardFontDataUrl', filename: 'font.pfb' }))).toEqual([4, 5])
    expect(Array.from(await factory.fetch({ kind: 'wasmUrl', filename: 'decoder.wasm' }))).toEqual([6, 7, 8])
  })

  it('hands PDF.js a fresh buffer every time', async () => {
    const factory = new (createPdfBinaryDataFactory(ASSETS))()
    const first = await factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' })
    structuredClone(first, { transfer: [first.buffer] })
    expect(first.byteLength).toBe(0)
    expect(Array.from(await factory.fetch({ kind: 'cMapUrl', filename: 'sample.bcmap' }))).toEqual([1, 2, 3])
  })

  it.each(['../font.pfb', 'missing.bcmap', 'toString'])('rejects unbundled %s without fetching', async (filename) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(new (createPdfBinaryDataFactory(ASSETS))().fetch({ kind: 'cMapUrl', filename }))
      .rejects.toThrow('not bundled')
    expect(fetch).not.toHaveBeenCalled()
  })
})
