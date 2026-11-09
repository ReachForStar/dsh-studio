/** Selection geometry: clipping to the page box and percentage overlays. */
import { describe, expect, it } from 'vitest'
import { normalizeRects, overlayStyle, type ClientBox } from '../src/client/selection.ts'

const PAGE: ClientBox = { left: 100, top: 200, right: 300, bottom: 600 }

describe('normalizeRects', () => {
  it('reduces a client rectangle to fractions of the page box', () => {
    const [rect] = normalizeRects([{ left: 150, top: 300, right: 250, bottom: 400 }], PAGE)
    expect(rect).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.25 })
  })

  it('clips a rectangle that hangs over the page edges', () => {
    const [rect] = normalizeRects([{ left: 0, top: 0, right: 150, bottom: 700 }], PAGE)
    expect(rect).toEqual({ x: 0, y: 0, width: 0.25, height: 1 })
  })

  it('drops a rectangle entirely outside the page', () => {
    expect(normalizeRects([{ left: 400, top: 300, right: 500, bottom: 400 }], PAGE)).toEqual([])
    expect(normalizeRects([{ left: 150, top: 700, right: 250, bottom: 800 }], PAGE)).toEqual([])
  })

  it('drops a rectangle that only touches an edge', () => {
    expect(normalizeRects([{ left: 100, top: 300, right: 100, bottom: 400 }], PAGE)).toEqual([])
    expect(normalizeRects([{ left: 150, top: 200, right: 250, bottom: 200 }], PAGE)).toEqual([])
  })

  it('keeps one rectangle per non-empty selection box, in order', () => {
    const rects = normalizeRects([
      { left: 100, top: 200, right: 300, bottom: 300 },
      { left: 400, top: 200, right: 500, bottom: 300 },
      { left: 100, top: 500, right: 300, bottom: 600 },
    ], PAGE)
    expect(rects).toEqual([
      { x: 0, y: 0, width: 1, height: 0.25 },
      { x: 0, y: 0.75, width: 1, height: 0.25 },
    ])
  })

  it('drops every rectangle when the page box has no area', () => {
    const rect = { left: 100, top: 200, right: 300, bottom: 600 }
    expect(normalizeRects([rect], { left: 100, top: 200, right: 100, bottom: 600 })).toEqual([])
    expect(normalizeRects([rect], { left: 100, top: 200, right: 300, bottom: 200 })).toEqual([])
  })
})

describe('overlayStyle', () => {
  it('expresses a normalized rectangle as page percentages', () => {
    expect(overlayStyle({ x: 0.25, y: 0.5, width: 0.125, height: 1 })).toEqual({
      left: '25%', top: '50%', width: '12.5%', height: '100%',
    })
  })
})
