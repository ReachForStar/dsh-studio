/**
 * Selection geometry: browser client rectangles reduced to fractions of one
 * page box, so a highlight keeps its place under any zoom or layout width.
 */
import type { PaperRect } from '../types.ts'

/** A rectangle in viewport coordinates. */
export interface ClientBox {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/**
 * Clip one selection rectangle to its page and normalize it.
 * @param rect - selection rectangle in viewport coordinates.
 * @param page - page box in viewport coordinates.
 * @returns the normalized rectangle, or undefined when the intersection is empty.
 */
function normalizeRect(rect: ClientBox, page: ClientBox): PaperRect | undefined {
  const width = page.right - page.left
  const height = page.bottom - page.top
  if (width <= 0 || height <= 0) return undefined
  const left = Math.max(rect.left, page.left)
  const top = Math.max(rect.top, page.top)
  const right = Math.min(rect.right, page.right)
  const bottom = Math.min(rect.bottom, page.bottom)
  if (right <= left || bottom <= top) return undefined
  return {
    x: (left - page.left) / width,
    y: (top - page.top) / height,
    width: (right - left) / width,
    height: (bottom - top) / height,
  }
}

/**
 * Reduce a selection's client rectangles to page-relative rectangles.
 * @param rects - client rectangles of one selection range.
 * @param page - the page surface those rectangles were selected on.
 * @returns one normalized rectangle per non-empty intersection, in reading order.
 */
export function normalizeRects(rects: readonly ClientBox[], page: ClientBox): readonly PaperRect[] {
  return rects.flatMap((rect) => {
    const normalized = normalizeRect(rect, page)
    return normalized === undefined ? [] : [normalized]
  })
}

/**
 * Convert a normalized rectangle back to percentage offsets for an overlay.
 * @param rect - normalized page rectangle.
 * @returns CSS percentage values relative to the page box.
 */
export function overlayStyle(rect: PaperRect): Record<string, string> {
  return {
    left: `${String(rect.x * 100)}%`,
    top: `${String(rect.y * 100)}%`,
    width: `${String(rect.width * 100)}%`,
    height: `${String(rect.height * 100)}%`,
  }
}
