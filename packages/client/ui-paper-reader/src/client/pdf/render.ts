/** Canvas rendering with cancellation and page cleanup for one paper page. */
import type { PDFPageProxy } from 'pdfjs-dist'
import type { PdfDocument } from './runtime.ts'
import type { RenderPdfText } from './text.ts'

/** Page geometry expressed in CSS pixels. */
export interface PdfPageSize {
  readonly width: number
  readonly height: number
}

/** CSS pixels per PDF point, matching PDF.js's default viewer scale. */
const CSS_SCALE = 96 / 72

/** Largest raster area one page may allocate, in device pixels. */
const MAX_RASTER_AREA = 16_777_216

/**
 * Render one page into an exclusively owned canvas. Cancellation cannot write
 * dimensions after a delayed getPage; active render tasks are cancelled and
 * awaited before the page is cleaned up.
 * @param document - loaded document.
 * @param pageNumber - one-based page number.
 * @param canvas - canvas this page owns.
 * @param signal - page lifetime.
 * @param pixelRatio - device pixel ratio used for raster sharpness.
 * @param renderText - optional text layer sharing the page's cleanup barrier.
 * @returns the page's CSS dimensions after rendering completes.
 */
export async function renderPdfPage(
  document: PdfDocument,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
  pixelRatio: number,
  renderText?: RenderPdfText,
): Promise<PdfPageSize> {
  signal.throwIfAborted()
  const page: PDFPageProxy = await document.getPage(pageNumber)
  try {
    signal.throwIfAborted()
    const viewport = page.getViewport({ scale: CSS_SCALE })
    // Limit raster allocation without changing the document's display dimensions.
    const ratio = Math.min(pixelRatio, Math.sqrt(MAX_RASTER_AREA / (viewport.width * viewport.height)))
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
    const task = page.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    })
    let text: ReturnType<RenderPdfText> | undefined
    let cancelled = false
    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      task.cancel()
      text?.cancel()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      text = renderText?.(page, viewport)
      // An abort during text setup already ran `cancel` before the task
      // existed; the layer it created still needs cancelling.
      if (cancelled) text?.cancel()
      else if (signal.aborted) cancel()
      await Promise.all([task.promise, text?.promise])
      signal.throwIfAborted()
      return { width: viewport.width, height: viewport.height }
    } catch (error) {
      cancel()
      await Promise.allSettled([task.promise, text?.promise])
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  } finally {
    page.cleanup()
  }
}
