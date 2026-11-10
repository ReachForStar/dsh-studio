// @vitest-environment jsdom
/** The paper surface: page stack, persisted highlights, and the selection menu. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PDFPageProxy } from 'pdfjs-dist'
import type { PaperAnnotation } from '../src/types.ts'

const api = vi.hoisted(() => ({
  openPdf: vi.fn(),
  render: vi.fn(),
  text: vi.fn(),
}))
vi.mock('../src/client/pdf/runtime.ts', () => ({ openPdf: api.openPdf }))
vi.mock('../src/client/pdf/render.ts', () => ({ renderPdfPage: api.render }))
vi.mock('../src/client/pdf/text.ts', () => ({ pdfTextRenderer: api.text }))
import { PdfViewer } from '../src/client/PdfViewer.tsx'

const t = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`

const DATA = new Uint8Array([37, 80, 68, 70])

const ANNOTATION: PaperAnnotation = {
  id: 'a1', page: 1, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
  text: 'quoted passage', note: 'my thought', createdAt: '2026-11-09T00:00:00.000Z',
}

/** A document whose pages render from the shared stubs. */
function documentOf(numPages = 2) {
  return { numPages, getPage: vi.fn(async () => ({} as PDFPageProxy)) }
}

/** Start one viewer with a controllable PDF session. */
function start(options: {
  readonly annotations?: readonly PaperAnnotation[]
  readonly ask?: (text: string) => boolean
  readonly signal?: AbortSignal
  readonly pending?: boolean
} = {}) {
  const document = documentOf()
  const dispose = vi.fn(async () => {})
  const state: { failed?: (error: unknown) => void } = {}
  const opened = options.pending === true ? new Promise<never>(() => {}) : Promise.resolve(document)
  api.openPdf.mockImplementation((_data: unknown, _signal: AbortSignal, failed: (error: unknown) => void) => {
    state.failed = failed
    return { document: opened, dispose }
  })
  const onCreate = vi.fn()
  const onRemove = vi.fn()
  const ask = options.ask ?? vi.fn(() => true)
  const rendered = render(
    <PdfViewer data={DATA} annotations={options.annotations ?? []}
      signal={options.signal ?? new AbortController().signal} t={t} ask={ask}
      onCreate={onCreate} onRemove={onRemove} />,
  )
  return {
    ...rendered, document, dispose, onCreate, onRemove, ask,
    failed: (error: unknown) => { state.failed?.(error) },
    ready: async () => { await waitFor(() => { expect(screen.getAllByRole('img').length).toBeGreaterThan(0) }) },
  }
}

/** Select one line of text inside page one and open the floating menu. */
async function select(container: HTMLElement, text = 'chosen words'): Promise<void> {
  const page = container.querySelector('[data-paper-page="1"]') as HTMLElement
  const surface = page.querySelector('[data-paper-surface]') as HTMLElement
  const node = document.createTextNode(text)
  surface.appendChild(node)
  const range = document.createRange()
  range.selectNodeContents(node)
  range.getClientRects = () => [{ left: 120, top: 220, right: 220, bottom: 260 }] as unknown as DOMRectList
  range.getBoundingClientRect = () => ({ left: 120, top: 220, right: 220, bottom: 260 }) as DOMRect
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(
    { left: 100, top: 200, right: 300, bottom: 600, width: 200, height: 400 } as DOMRect)
  const browserSelection = {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  }
  vi.spyOn(window, 'getSelection').mockReturnValue(browserSelection as unknown as Selection)
  fireEvent.mouseUp(container.querySelector('[data-paper-page="1"]')?.parentElement as HTMLElement)
  await waitFor(() => { expect(screen.getByRole('menu')).toBeDefined() })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.render.mockResolvedValue({ width: 200, height: 400 })
  api.text.mockReturnValue(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
  vi.stubGlobal('devicePixelRatio', 2)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('paper pages', () => {
  it('shows a status until the document opens, then every page with its highlights', async () => {
    const h = start({ annotations: [ANNOTATION] })
    expect(screen.getByRole('status').textContent).toBe('loading')
    await h.ready()
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(screen.getByRole('img', { name: 'pageLabel:{"page":1}' })).toBeDefined()
    expect(h.container.querySelectorAll('[data-paper-page]')).toHaveLength(2)
    expect(h.container.querySelectorAll('[data-paper-surface]')[0]?.hasAttribute('hidden')).toBe(false)
  })

  it('lists the annotations with their note and removes one', async () => {
    const h = start({ annotations: [ANNOTATION] })
    await h.ready()
    expect(screen.getByText('quoted passage')).toBeDefined()
    expect(screen.getByText('my thought')).toBeDefined()
    fireEvent.click(screen.getByLabelText('removeAnnotation'))
    expect(h.onRemove).toHaveBeenCalledWith('a1')
  })

  it('leaves a note absent when the annotation has none', async () => {
    const bare = {
      id: 'a2', page: 1, rects: ANNOTATION.rects, text: 'plain quote', createdAt: ANNOTATION.createdAt,
    } as PaperAnnotation
    const h = start({ annotations: [bare] })
    await h.ready()
    expect(screen.getByText('plain quote')).toBeDefined()
    expect(screen.queryByText('noteLabel:')).toBeNull()
  })

  it('says so when nothing is annotated yet', async () => {
    const h = start()
    await h.ready()
    expect(screen.getByText('noAnnotations')).toBeDefined()
  })

  it('reports a document that cannot be opened', async () => {
    api.openPdf.mockReturnValue({ document: Promise.reject(new Error('broken')), dispose: vi.fn() })
    render(<PdfViewer data={DATA} annotations={[]} signal={new AbortController().signal}
      t={t} ask={vi.fn()} onCreate={vi.fn()} onRemove={vi.fn()} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('loadFailed') })
  })

  it('reports a worker failure raised after the session started', async () => {
    const h = start({ pending: true })
    expect(screen.getByRole('status').textContent).toBe('loading')
    await act(async () => { h.failed(new Error('worker blocked')) })
    expect(screen.getByRole('alert').textContent).toBe('loadFailed')
  })

  it('disposes the PDF session when the viewer goes away', async () => {
    const h = start()
    await h.ready()
    h.unmount()
    await waitFor(() => { expect(h.dispose).toHaveBeenCalledOnce() })
  })

  it('cancels the text layer it handed to the page renderer', async () => {
    const cancel = vi.fn()
    api.text.mockReturnValue(() => ({ promise: Promise.resolve(), cancel }))
    let textTask: { cancel(): void } | undefined
    api.render.mockImplementation(async (
      _document: unknown, _page: number, _canvas: unknown, _signal: unknown, _ratio: unknown,
      renderText: (page: unknown, viewport: unknown) => { cancel(): void },
    ) => {
      textTask = renderText({}, { width: 1, height: 1 })
      return { width: 200, height: 400 }
    })
    const h = start()
    await h.ready()
    expect(textTask).toBeDefined()
    h.unmount()
    expect(cancel).toHaveBeenCalled()
  })

  it('ignores a document that resolves after the viewer closed', async () => {
    const opened = Promise.withResolvers<{ numPages: number; getPage(): Promise<PDFPageProxy> }>()
    api.openPdf.mockReturnValue({ document: opened.promise, dispose: vi.fn() })
    const { unmount } = render(<PdfViewer data={DATA} annotations={[]} signal={new AbortController().signal}
      t={t} ask={vi.fn()} onCreate={vi.fn()} onRemove={vi.fn()} />)
    unmount()
    opened.resolve(documentOf())
    await act(async () => { await Promise.resolve() })
  })

  it('ignores a document that fails after the viewer closed', async () => {
    const opened = Promise.withResolvers<never>()
    api.openPdf.mockReturnValue({ document: opened.promise, dispose: vi.fn() })
    const { unmount } = render(<PdfViewer data={DATA} annotations={[]} signal={new AbortController().signal}
      t={t} ask={vi.fn()} onCreate={vi.fn()} onRemove={vi.fn()} />)
    unmount()
    opened.reject(new Error('late'))
    await act(async () => { await Promise.resolve() })
  })

  it('ignores a worker failure raised after the viewer closed', async () => {
    const h = start({ pending: true })
    h.unmount()
    h.failed(new Error('late'))
  })

  it('ignores a page that finishes or fails after the viewer closed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const finished = Promise.withResolvers<{ width: number; height: number }>()
    api.render.mockReturnValueOnce(finished.promise)
    const first = start()
    await waitFor(() => { expect(api.render).toHaveBeenCalledOnce() })
    first.unmount()
    finished.resolve({ width: 200, height: 400 })
    await act(async () => { await Promise.resolve() })

    const failed = Promise.withResolvers<{ width: number; height: number }>()
    api.render.mockReturnValueOnce(failed.promise)
    const second = start()
    await waitFor(() => { expect(api.render).toHaveBeenCalledTimes(2) })
    second.unmount()
    failed.reject(new Error('late'))
    await act(async () => { await Promise.resolve() })
    expect(log).not.toHaveBeenCalled()
  })

  it('reports a page that cannot render and logs its cause', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.render.mockRejectedValue(new Error('raster failed'))
    start()
    await waitFor(() => { expect(screen.getAllByRole('alert')[0]?.textContent).toBe('pageFailed') })
    expect(log).toHaveBeenCalledWith('[paper-reader] page 1 failed', expect.any(Error))
  })
})

describe('lazy pages', () => {
  it('renders every page at once without an IntersectionObserver', async () => {
    const h = start()
    await h.ready()
    expect(api.render).toHaveBeenCalledTimes(2)
    expect(h.container.querySelectorAll('[data-paper-page]')).toHaveLength(2)
  })

  it('waits for a page to approach the viewport before rendering it', async () => {
    const observed: Element[] = []
    let intersect: ((entries: IntersectionObserverEntry[]) => void) | undefined
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) { intersect = callback }
      observe = (element: Element) => { observed.push(element) }
      disconnect = vi.fn()
    })
    const h = start()
    await waitFor(() => { expect(screen.getAllByRole('img')).toHaveLength(1) })
    expect(api.render).toHaveBeenCalledTimes(1)
    expect(observed).toHaveLength(2)
    intersect?.([{ isIntersecting: false } as IntersectionObserverEntry])
    await act(async () => { await Promise.resolve() })
    expect(api.render).toHaveBeenCalledTimes(1)
    intersect?.([{ isIntersecting: true } as IntersectionObserverEntry])
    await waitFor(() => { expect(api.render).toHaveBeenCalledTimes(2) })
    expect(h.container.querySelectorAll('[data-paper-page]')).toHaveLength(2)
  })
})

describe('selection menu', () => {
  it('highlights the selected text and closes the menu', async () => {
    const h = start()
    await h.ready()
    await select(h.container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'highlight' }))
    expect(h.onCreate).toHaveBeenCalledWith(expect.objectContaining({
      page: 1, text: 'chosen words', rects: [{ x: 0.1, y: 0.05, width: 0.5, height: 0.1 }],
    }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('saves a note written for the selection', async () => {
    const h = start()
    await h.ready()
    await select(h.container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'addNote' }))
    fireEvent.change(screen.getByPlaceholderText('notePlaceholder'), { target: { value: '  a thought  ' } })
    fireEvent.click(screen.getByText('saveNote'))
    expect(h.onCreate).toHaveBeenCalledWith(expect.objectContaining({ note: 'a thought' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps an empty note absent', async () => {
    const h = start()
    await h.ready()
    await select(h.container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'addNote' }))
    fireEvent.click(screen.getByText('saveNote'))
    expect(h.onCreate.mock.calls[0]?.[0]).not.toHaveProperty('note')
  })

  it('cancels the note without creating an annotation', async () => {
    const h = start()
    await h.ready()
    await select(h.container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'addNote' }))
    fireEvent.click(screen.getByText('cancel'))
    expect(h.onCreate).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('asks the conversation about the selection', async () => {
    const ask = vi.fn(() => true)
    const h = start({ ask })
    await h.ready()
    await select(h.container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'ask' }))
    expect(ask).toHaveBeenCalledWith('chosen words')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the menu and reports a conversation that accepts no input', async () => {
    const h = start({ ask: () => false })
    await h.ready()
    await select(h.container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'ask' }))
    expect(screen.getByRole('menu')).toBeDefined()
    expect(screen.getByRole('alert').textContent).toBe('askUnavailable')
  })

  it('closes on an outside pointer, Escape, or scroll, but not inside the menu', async () => {
    const h = start()
    await h.ready()

    await select(h.container)
    fireEvent.pointerDown(screen.getByRole('menu'))
    expect(screen.queryByRole('menu')).not.toBeNull()

    fireEvent.keyDown(document.body, { key: 'a' })
    expect(screen.queryByRole('menu')).not.toBeNull()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()

    await select(h.container)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    await select(h.container)
    fireEvent.scroll(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('ignores a selection inside a page that has no surface', async () => {
    const h = start()
    await h.ready()
    const bare = document.createElement('div')
    bare.dataset.paperPage = '1'
    const node = document.createTextNode('text')
    bare.appendChild(node)
    h.container.appendChild(bare)
    const range = document.createRange()
    range.selectNodeContents(node)
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false, rangeCount: 1, toString: () => 'text', getRangeAt: () => range,
      removeAllRanges: vi.fn(),
    } as unknown as Selection)
    fireEvent.mouseUp(h.container.firstElementChild as HTMLElement)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('ignores a selection whose boxes all fall outside the page', async () => {
    const h = start()
    await h.ready()
    const page = h.container.querySelector('[data-paper-page="1"]') as HTMLElement
    const surface = page.querySelector('[data-paper-surface]') as HTMLElement
    const node = document.createTextNode('text')
    surface.appendChild(node)
    const range = document.createRange()
    range.selectNodeContents(node)
    range.getClientRects = () => [{ left: 900, top: 900, right: 950, bottom: 950 }] as unknown as DOMRectList
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(
      { left: 100, top: 200, right: 300, bottom: 600, width: 200, height: 400 } as DOMRect)
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false, rangeCount: 1, toString: () => 'text', getRangeAt: () => range,
      removeAllRanges: vi.fn(),
    } as unknown as Selection)
    fireEvent.mouseUp(h.container.firstElementChild as HTMLElement)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('ignores a collapsed, empty, or cross-page selection', async () => {
    const h = start()
    await h.ready()
    const viewer = h.container.firstElementChild as HTMLElement

    vi.spyOn(window, 'getSelection').mockReturnValue(null)
    fireEvent.mouseUp(viewer)

    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true, rangeCount: 0, toString: () => '', getRangeAt: () => document.createRange(),
      removeAllRanges: vi.fn(),
    } as unknown as Selection)
    fireEvent.mouseUp(viewer)

    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false, rangeCount: 1, toString: () => '   ', getRangeAt: () => document.createRange(),
      removeAllRanges: vi.fn(),
    } as unknown as Selection)
    fireEvent.mouseUp(viewer)

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('ignores a selection whose boundaries leave the page surface', async () => {
    const h = start()
    await h.ready()
    const outside = document.createElement('span')
    h.container.appendChild(outside)
    const range = document.createRange()
    range.selectNodeContents(outside)
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false, rangeCount: 1, toString: () => 'text', getRangeAt: () => range,
      removeAllRanges: vi.fn(),
    } as unknown as Selection)
    fireEvent.mouseUp(h.container.firstElementChild as HTMLElement)
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('opens the highlight menu from a click inside an annotation and removes it', async () => {
    const h = start({ annotations: [ANNOTATION] })
    await h.ready()
    const surface = h.container.querySelector('[data-paper-surface]') as HTMLElement
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(
      { left: 100, top: 200, right: 300, bottom: 600, width: 200, height: 400 } as DOMRect)
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true, rangeCount: 0, toString: () => '', getRangeAt: () => document.createRange(), removeAllRanges: vi.fn(),
    } as unknown as Selection)
    fireEvent.click(surface, { clientX: 100 + 0.25 * 200, clientY: 200 + 0.4 * 400 })

    const menu = await screen.findByRole('menu')
    expect(menu.textContent).toContain('quoted passage')
    expect(menu.textContent).toContain('my thought')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'removeAnnotation' }))
    expect(h.onRemove).toHaveBeenCalledExactlyOnceWith('a1')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens the menu for a highlight without a note and closes it again', async () => {
    const { note: _note, ...withoutNote } = ANNOTATION
    const h = start({ annotations: [{ ...withoutNote, id: 'a2' }] })
    await h.ready()
    const surface = h.container.querySelector('[data-paper-surface]') as HTMLElement
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, right: 200, bottom: 400, width: 200, height: 400 } as DOMRect)
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true, rangeCount: 0, toString: () => '', getRangeAt: () => document.createRange(), removeAllRanges: vi.fn(),
    } as unknown as Selection)
    fireEvent.click(surface, { clientX: 50, clientY: 160 })
    const menu = await screen.findByRole('menu')
    expect(menu.textContent).toContain('quoted passage')
    expect(menu.textContent).not.toContain('my thought')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'cancel' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('leaves clicks outside the highlights, outside the surface, and inside a selection alone', async () => {
    const h = start({ annotations: [ANNOTATION] })
    await h.ready()
    const surface = h.container.querySelector('[data-paper-surface]') as HTMLElement
    const bounds = { left: 0, top: 0, right: 200, bottom: 400, width: 200, height: 400 } as DOMRect
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(bounds)
    const selection = { isCollapsed: true, rangeCount: 0, toString: () => '', getRangeAt: () => document.createRange(), removeAllRanges: vi.fn() }
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection)
    fireEvent.click(surface, { clientX: 190, clientY: 390 })
    expect(screen.queryByRole('menu')).toBeNull()

    surface.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
    })
    fireEvent.click(surface, { clientX: 50, clientY: 160 })
    expect(screen.queryByRole('menu')).toBeNull()

    surface.getBoundingClientRect = () => bounds
    vi.spyOn(window, 'getSelection').mockReturnValue({ ...selection, isCollapsed: false } as unknown as Selection)
    fireEvent.click(surface, { clientX: 50, clientY: 160 })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('dismisses the highlight menu on an outside pointer and on Escape', async () => {
    const h = start({ annotations: [ANNOTATION] })
    await h.ready()
    const surface = h.container.querySelector('[data-paper-surface]') as HTMLElement
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, right: 200, bottom: 400, width: 200, height: 400 } as DOMRect)
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true, rangeCount: 0, toString: () => '', getRangeAt: () => document.createRange(), removeAllRanges: vi.fn(),
    } as unknown as Selection)
    fireEvent.click(surface, { clientX: 50, clientY: 160 })
    const first = await screen.findByRole('menu')
    fireEvent.pointerDown(first)
    expect(screen.queryByRole('menu')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(surface, { clientX: 50, clientY: 160 })
    await screen.findByRole('menu')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
