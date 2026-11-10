// @vitest-environment jsdom
/** Canvas rendering: page ownership, raster bounds, and cancellation before cleanup. */
import { describe, expect, it, vi } from 'vitest'
import type { PDFPageProxy } from 'pdfjs-dist'
import { renderPdfPage } from '../src/client/pdf/render.ts'

/** A document whose one page is the supplied proxy. */
function documentOf(page: PDFPageProxy) {
  return { numPages: 1, getPage: async () => page }
}

describe('renderPdfPage', () => {
  it('renders the page at CSS scale and reports its display size', async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
    const cleanup = vi.fn()
    const getViewport = vi.fn(() => ({ width: 600, height: 800 }))
    const page = {
      getViewport,
      render,
      cleanup,
    } as unknown as PDFPageProxy
    const canvas = document.createElement('canvas')
    await expect(renderPdfPage(documentOf(page), 1, canvas, new AbortController().signal, 1))
      .resolves.toEqual({ width: 600, height: 800 })
    expect(getViewport).toHaveBeenCalledWith({ scale: 96 / 72 })
    expect(canvas.width).toBe(600)
    expect(canvas.height).toBe(800)
    expect(render).toHaveBeenCalledWith({ canvas, viewport: { width: 600, height: 800 }, transform: undefined })
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('scales the raster by the device pixel ratio', async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
    const page = {
      getViewport: () => ({ width: 300, height: 400 }),
      render,
      cleanup: vi.fn(),
    } as unknown as PDFPageProxy
    const canvas = document.createElement('canvas')
    await renderPdfPage(documentOf(page), 1, canvas, new AbortController().signal, 2)
    expect(canvas.width).toBe(600)
    expect(canvas.height).toBe(800)
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ transform: [2, 0, 0, 2, 0, 0] }))
  })

  it('bounds the raster area without changing the display size', async () => {
    const page = {
      getViewport: () => ({ width: 8192, height: 8192 }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn(),
    } as unknown as PDFPageProxy
    const canvas = document.createElement('canvas')
    await expect(renderPdfPage(documentOf(page), 1, canvas, new AbortController().signal, 4))
      .resolves.toEqual({ width: 8192, height: 8192 })
    expect(canvas.width * canvas.height).toBe(16_777_216)
  })

  it('never touches the canvas when cancelled before the page arrives', async () => {
    const controller = new AbortController()
    controller.abort()
    const canvas = document.createElement('canvas')
    const getPage = vi.fn()
    await expect(renderPdfPage({ numPages: 1, getPage }, 1, canvas, controller.signal, 1))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(getPage).not.toHaveBeenCalled()
    expect(canvas.width).toBe(300)
  })

  it('cleans the page up when cancelled after it arrives', async () => {
    const controller = new AbortController()
    const cleanup = vi.fn()
    const render = vi.fn()
    const page = {
      getViewport: () => ({ width: 100, height: 80 }),
      render,
      cleanup,
    } as unknown as PDFPageProxy
    const pending = renderPdfPage({ numPages: 1, getPage: async () => page }, 1,
      document.createElement('canvas'), controller.signal, 1)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(render).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('cancels both the canvas task and the text layer when text rendering fails', async () => {
    const rendered = Promise.withResolvers<undefined>()
    const cancelCanvas = vi.fn(() => { rendered.resolve(undefined) })
    const cancelText = vi.fn()
    const cleanup = vi.fn()
    const page = {
      getViewport: () => ({ width: 100, height: 80 }),
      render: () => ({ promise: rendered.promise, cancel: cancelCanvas }),
      cleanup,
    } as unknown as PDFPageProxy
    const pending = renderPdfPage(documentOf(page), 1, document.createElement('canvas'),
      new AbortController().signal, 1, () => ({ promise: Promise.reject(new Error('text failed')), cancel: cancelText }))
    await expect(pending).rejects.toThrow('text failed')
    expect(cancelText).toHaveBeenCalledOnce()
    expect(cancelCanvas).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('cancels an active task on abort and cleans up after it settles', async () => {
    const running = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const cleanup = vi.fn()
    const cancel = vi.fn()
    const page = {
      getViewport: () => ({ width: 100, height: 80 }),
      render: () => { entered.resolve(undefined); return { promise: running.promise, cancel } },
      cleanup,
    } as unknown as PDFPageProxy
    const pending = renderPdfPage(documentOf(page), 1, document.createElement('canvas'), controller.signal, 1)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await entered.promise
    controller.abort()
    expect(cancel).toHaveBeenCalledOnce()
    expect(cleanup).not.toHaveBeenCalled()
    running.reject(new Error('cancelled'))
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('cancels when the owner aborts during the library render call', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const cleanup = vi.fn()
    const page = {
      getViewport: () => ({ width: 100, height: 80 }),
      render: () => {
        controller.abort()
        return { promise: Promise.resolve(), cancel }
      },
      cleanup,
    } as unknown as PDFPageProxy
    await expect(renderPdfPage(documentOf(page), 1, document.createElement('canvas'), controller.signal, 1))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('cancels when the owner aborts during the text layer setup', async () => {
    const controller = new AbortController()
    const cancelCanvas = vi.fn()
    const cancelText = vi.fn()
    const page = {
      getViewport: () => ({ width: 100, height: 80 }),
      render: () => ({ promise: Promise.resolve(), cancel: cancelCanvas }),
      cleanup: vi.fn(),
    } as unknown as PDFPageProxy
    await expect(renderPdfPage(documentOf(page), 1, document.createElement('canvas'), controller.signal, 1, () => {
      controller.abort()
      return { promise: Promise.resolve(), cancel: cancelText }
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelCanvas).toHaveBeenCalledOnce()
    expect(cancelText).toHaveBeenCalledOnce()
  })
})
