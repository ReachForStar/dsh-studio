// @vitest-environment jsdom
/** ExcalidrawPanel: scene hydration, debounced saves, the model poll, theme
 * following, and PNG/SVG export. Excalidraw itself is replaced by a stand-in
 * that announces its imperative API the way the real component does. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ExcalidrawPanelProps } from '../src/client/ExcalidrawPanel.tsx'
import { ExcalidrawPanel } from '../src/client/ExcalidrawPanel.tsx'

/** Controllable stand-in for the lazily imported `@excalidraw/excalidraw`. */
const excalidraw = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  props: null as Record<string, unknown> | null,
  announceOnMount: true,
  exportToBlob: (async () => new Blob(['png'])) as (options: Record<string, unknown>) => Promise<Blob>,
  exportToSvg: (async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg')) as
    (options: Record<string, unknown>) => Promise<SVGSVGElement>,
}))

// The real component announces its imperative API once from its constructor and
// reads `theme`/`onChange` from the latest props on every render.
vi.mock('@excalidraw/excalidraw', async () => {
  const React = await import('react')
  const FakeExcalidraw = (props: Record<string, unknown>) => {
    React.useEffect(() => {
      if (excalidraw.announceOnMount) (props['excalidrawAPI'] as (api: unknown) => void)(excalidraw.api)
    }, [])
    React.useEffect(() => { excalidraw.props = props })
    return React.createElement('div', {
      'data-testid': 'excalidraw-canvas',
      'data-theme': props['theme'],
    })
  }
  return {
    Excalidraw: FakeExcalidraw,
    exportToBlob: (options: Record<string, unknown>) => excalidraw.exportToBlob(options),
    exportToSvg: (options: Record<string, unknown>) => excalidraw.exportToSvg(options),
  }
})

interface FakeApi {
  updateScene: ReturnType<typeof vi.fn>
  getSceneElements: ReturnType<typeof vi.fn>
  getAppState: ReturnType<typeof vi.fn>
  getFiles: ReturnType<typeof vi.fn>
  getName: ReturnType<typeof vi.fn>
}

/** One fake scene file reply for `/scene/current` or `/scene/write`. */
interface FakeReply {
  status: number
  body?: unknown
  jsonFails?: boolean
  gate?: Promise<void>
  throws?: unknown
}

interface FetchCall {
  url: string
  body: Record<string, unknown>
}

interface TimeoutRecord {
  id: number
  delay: number
  run: () => void
}

const SESSION_ID = 's-1'
const WORKSPACE_PATH = '/ws'
// Poll interval ids live far outside jsdom's timer range so clearing a fake id
// can never hit a real timer.
const FAKE_INTERVAL_ID_BASE = 1_000_000

const realSetTimeout = globalThis.setTimeout.bind(globalThis)
const realClearTimeout = globalThis.clearTimeout.bind(globalThis)
const realSetInterval = globalThis.setInterval.bind(globalThis)
const realClearInterval = globalThis.clearInterval.bind(globalThis)
const originalCreateObjectURL = (URL as unknown as Record<string, unknown>)['createObjectURL']
const originalRevokeObjectURL = (URL as unknown as Record<string, unknown>)['revokeObjectURL']

let api: FakeApi
let sceneReply: FakeReply
let writeReply: FakeReply
let fetchCalls: FetchCall[]
let timeouts: TimeoutRecord[]
let pollTicks: Array<() => void>
let clearedIntervals: number[]
let nextIntervalId: number

/** A workspace row as the workspace controller projects it. */
function workspace(path: string): Record<string, unknown> {
  return { workspaceId: `w-${path}`, title: path, path, createdAt: '2026-01-01', sessionIds: [SESSION_ID] }
}

/** Build a fake scene file reply. */
function reply(status: number, body?: unknown, extra: Omit<FakeReply, 'status' | 'body'> = {}): FakeReply {
  return { status, body, ...extra }
}

/** A pending promise the spec resolves to release a gated response. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release: () => { release() } }
}

/** Render the panel over mutable session/workspace stubs. */
function panel(options: { items?: Array<Record<string, unknown>> } = {}) {
  let items = options.items ?? [workspace(WORKSPACE_PATH)]
  const props = {
    useSession: (selector: (snapshot: { sessionId: string }) => unknown): unknown => selector({ sessionId: SESSION_ID }),
    useWorkspaces: (selector: (snapshot: { items: unknown }) => unknown): unknown => selector({ items }),
    t: (key: string) => key,
  } as unknown as ExcalidrawPanelProps
  const view = render(<ExcalidrawPanel {...props} />)
  return {
    view,
    setWorkspaces(next: Array<Record<string, unknown>>): void {
      items = next
      view.rerender(<ExcalidrawPanel {...props} />)
    },
  }
}

/** Latest `onChange` the stand-in received. */
function canvasOnChange(): (elements: unknown[], appState: object) => void {
  if (excalidraw.props === null) throw new Error('canvas is not mounted')
  return excalidraw.props['onChange'] as (elements: unknown[], appState: object) => void
}

/** Latest `excalidrawAPI` announcement callback the stand-in received. */
function canvasApiAnnouncement(): (api: unknown) => void {
  if (excalidraw.props === null) throw new Error('canvas is not mounted')
  return excalidraw.props['excalidrawAPI'] as (api: unknown) => void
}

const currentCalls = (): FetchCall[] => fetchCalls.filter(call => call.url === '/scene/current')
const writeCalls = (): FetchCall[] => fetchCalls.filter(call => call.url === '/scene/write')

/** The scene payload the panel posted to `/scene/write`. */
function savedScene(): { elements: unknown[]; appState: Record<string, unknown> } {
  return JSON.parse(String(writeCalls()[0]?.body['scene'])) as { elements: unknown[]; appState: Record<string, unknown> }
}

/** Fire the newest timer scheduled with the given delay, cancelling its real twin. */
function fireTimeout(delay: number): void {
  const index = timeouts.findLastIndex(record => record.delay === delay)
  const record = index === -1 ? undefined : timeouts.splice(index, 1)[0]
  if (record === undefined) throw new Error(`no ${delay}ms timer scheduled`)
  realClearTimeout(record.id)
  act(() => { record.run() })
}

/** Run the scheduled poll tick and wait for its request to land. */
async function firePoll(): Promise<void> {
  const tick = pollTicks.at(-1)
  if (tick === undefined) throw new Error('no poll scheduled')
  const before = currentCalls().length
  await act(async () => { tick() })
  await waitFor(() => { expect(currentCalls().length).toBe(before + 1) })
}

/** Let pending request/response microtasks settle. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => { realSetTimeout(resolve, 0) }) })
}

/** Wait until the lazy canvas mounted and captured its props. */
async function awaitCanvas(): Promise<void> {
  await waitFor(() => { expect(excalidraw.props).not.toBeNull() })
  await settle()
}

/** Make `URL.createObjectURL` available (jsdom does not implement it). */
function stubDownloads() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:fake')
  const revokeObjectURL = vi.fn((_url: string) => undefined)
  Object.assign(URL, { createObjectURL, revokeObjectURL })
  return { createObjectURL, revokeObjectURL }
}

beforeEach(() => {
  document.body.removeAttribute('data-ds-dark-theme')
  fetchCalls = []
  sceneReply = reply(404)
  writeReply = reply(200, { ok: true })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    fetchCalls.push({ url, body: init?.body === undefined ? {} : JSON.parse(init.body) as Record<string, unknown> })
    const current = url === '/scene/current' ? sceneReply : writeReply
    if (current.throws !== undefined) throw current.throws
    return {
      status: current.status,
      ok: current.status >= 200 && current.status < 300,
      json: async () => {
        if (current.gate !== undefined) await current.gate
        if (current.jsonFails === true) throw new Error('unreadable body')
        return current.body ?? {}
      },
    }
  }))

  api = {
    updateScene: vi.fn(),
    getSceneElements: vi.fn(() => [{ id: 'a', type: 'rectangle' }]),
    getAppState: vi.fn(() => ({ viewBackgroundColor: '#fafafa' })),
    getFiles: vi.fn(() => ({})),
    getName: vi.fn(() => 'canvas'),
  }
  excalidraw.api = api as unknown as Record<string, unknown>
  excalidraw.props = null
  excalidraw.announceOnMount = true
  excalidraw.exportToBlob = async () => new Blob(['png'])
  excalidraw.exportToSvg = async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg')

  timeouts = []
  pollTicks = []
  clearedIntervals = []
  nextIntervalId = FAKE_INTERVAL_ID_BASE
  vi.spyOn(window, 'setTimeout').mockImplementation(((handler: () => void, delay?: number, ...args: unknown[]) => {
    const id = realSetTimeout(handler, delay, ...args)
    timeouts.push({ id, delay: delay ?? 0, run: () => { handler() } })
    return id
  }) as never)
  // The panel's 2s poll is driven tick by tick from the spec; every other
  // interval (waitFor's retry loop) keeps real scheduling.
  vi.spyOn(window, 'setInterval').mockImplementation(((handler: () => void, delay?: number) => {
    if (delay !== 2000) return realSetInterval(handler, delay)
    const id = nextIntervalId++
    pollTicks.push(() => { handler() })
    return id
  }) as never)
  vi.spyOn(window, 'clearInterval').mockImplementation(((id: number) => {
    if (id >= FAKE_INTERVAL_ID_BASE) { clearedIntervals.push(id); return }
    realClearInterval(id)
  }) as never)
})

afterEach(() => {
  cleanup()
  for (const record of timeouts) realClearTimeout(record.id)
  timeouts = []
  document.body.removeAttribute('data-ds-dark-theme')
  if (originalCreateObjectURL === undefined) delete (URL as unknown as Record<string, unknown>)['createObjectURL']
  else Object.assign(URL, { createObjectURL: originalCreateObjectURL })
  if (originalRevokeObjectURL === undefined) delete (URL as unknown as Record<string, unknown>)['revokeObjectURL']
  else Object.assign(URL, { revokeObjectURL: originalRevokeObjectURL })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ExcalidrawPanel workspace binding', () => {
  it('shows the workspace notice, disables export, and never polls without a workspace', () => {
    const view = panel({ items: [] })

    expect(view.view.getByText('git.noWorkspace')).toBeDefined()
    expect(view.view.queryByTestId('excalidraw-canvas')).toBeNull()
    expect(fetchCalls).toHaveLength(0)
    expect(pollTicks).toHaveLength(0)
    expect(view.view.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  })
})

describe('ExcalidrawPanel scene load', () => {
  it('hydrates the canvas with the persisted scene once the API is ready', async () => {
    sceneReply = reply(200, {
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#fff', zoom: { value: 1 }, selectedElementIds: { a: true } },
    })
    const view = panel()

    await waitFor(() => { expect(api.updateScene).toHaveBeenCalledTimes(1) })
    expect(api.updateScene).toHaveBeenCalledWith({
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#fff', zoom: { value: 1 } },
    })
    expect(currentCalls()[0]?.body).toEqual({ cwd: WORKSPACE_PATH })
    expect(view.view.getByText(WORKSPACE_PATH)).toBeDefined()
    expect(view.view.getByText('excalidraw.title')).toBeDefined()
    await settle()

    // A late announcement of the same API does not reload the scene.
    const calls = currentCalls().length
    act(() => { canvasApiAnnouncement()(api) })
    await settle()
    expect(currentCalls()).toHaveLength(calls)
    expect(api.updateScene).toHaveBeenCalledTimes(1)
  })

  it('starts with a blank canvas when the workspace has no scene file', async () => {
    sceneReply = reply(404)
    const view = panel()

    await awaitCanvas()
    expect(currentCalls().length).toBeGreaterThanOrEqual(1)
    expect(api.updateScene).not.toHaveBeenCalled()
    expect(view.view.queryByText('HTTP 404')).toBeNull()
  })

  it('applies a scene without an element list without recording a fingerprint', async () => {
    sceneReply = reply(200, { appState: { gridSize: 20 } })
    panel()

    await waitFor(() => { expect(api.updateScene).toHaveBeenCalledTimes(1) })
    expect(api.updateScene).toHaveBeenCalledWith({ elements: undefined, appState: { gridSize: 20 } })
  })

  it('reports scene errors, statuses, unreadable bodies, and non-Error rejections', async () => {
    sceneReply = reply(500, { error: 'disk full' })
    const reported = panel()
    await waitFor(() => { expect(reported.view.getByText('disk full')).toBeDefined() })
    cleanup()

    sceneReply = reply(500, {})
    const status = panel()
    await waitFor(() => { expect(status.view.getByText('HTTP 500')).toBeDefined() })
    cleanup()

    sceneReply = reply(500, {}, { jsonFails: true })
    const unreadable = panel()
    await waitFor(() => { expect(unreadable.view.getByText('HTTP 500')).toBeDefined() })
    cleanup()

    sceneReply = reply(200, {}, { throws: new Error('offline') })
    const offline = panel()
    await waitFor(() => { expect(offline.view.getByText('offline')).toBeDefined() })
    cleanup()

    sceneReply = reply(200, {}, { throws: 'gone' })
    const thrown = panel()
    await waitFor(() => { expect(thrown.view.getByText('gone')).toBeDefined() })
  })
})

describe('ExcalidrawPanel saves', () => {
  it('saves canvas changes after the debounce and remembers the saved fingerprint', async () => {
    const view = panel()
    await awaitCanvas()

    const gated = deferred()
    writeReply = reply(200, { ok: true }, { gate: gated.promise })
    act(() => {
      canvasOnChange()(
        [{ id: 'b', type: 'rectangle' }],
        { selectedElementIds: { b: true }, viewBackgroundColor: '#eee' },
      )
    })
    expect(writeCalls()).toHaveLength(0)
    fireTimeout(800)

    await waitFor(() => { expect(writeCalls()).toHaveLength(1) })
    expect(view.view.getByText('excalidraw.saving')).toBeDefined()
    expect(writeCalls()[0]?.body['cwd']).toBe(WORKSPACE_PATH)
    expect(savedScene()).toEqual({
      elements: [{ id: 'b', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#eee' },
    })

    gated.release()
    await waitFor(() => { expect(view.view.queryByText('excalidraw.saving')).toBeNull() })

    // The file now matches the canvas, so the poll leaves the canvas alone.
    sceneReply = reply(200, { elements: [{ id: 'b', type: 'rectangle' }], appState: {} })
    await firePoll()
    expect(api.updateScene).not.toHaveBeenCalled()

    // A model-written scene still lands.
    sceneReply = reply(200, { elements: [{ id: 'c', type: 'ellipse' }], appState: { gridSize: 10 } })
    await firePoll()
    await waitFor(() => { expect(api.updateScene).toHaveBeenCalledTimes(1) })
    expect(api.updateScene).toHaveBeenLastCalledWith({
      elements: [{ id: 'c', type: 'ellipse' }],
      appState: { gridSize: 10 },
    })
  })

  it('collapses rapid canvas changes into one save of the newest scene', async () => {
    panel()
    await awaitCanvas()

    act(() => { canvasOnChange()([{ id: 'a' }], {}) })
    act(() => { canvasOnChange()([{ id: 'b' }], {}) })
    expect(writeCalls()).toHaveLength(0)

    fireTimeout(800)
    await waitFor(() => { expect(writeCalls()).toHaveLength(1) })
    expect(savedScene().elements).toEqual([{ id: 'b' }])
  })

  it('reports save failures from the body, a missing message, and both rejection kinds', async () => {
    const view = panel()
    await awaitCanvas()
    const save = (id: string): void => {
      act(() => { canvasOnChange()([{ id }], {}) })
      fireTimeout(800)
    }

    writeReply = reply(200, { ok: false, error: 'readonly' })
    save('a')
    await waitFor(() => { expect(view.view.getByText('readonly')).toBeDefined() })

    writeReply = reply(200, { ok: false })
    save('b')
    await waitFor(() => { expect(view.view.getByText('save failed')).toBeDefined() })

    writeReply = reply(200, {}, { throws: new Error('offline') })
    save('c')
    await waitFor(() => { expect(view.view.getByText('offline')).toBeDefined() })

    writeReply = reply(200, {}, { throws: 'gone' })
    save('d')
    await waitFor(() => { expect(view.view.getByText('gone')).toBeDefined() })
    await waitFor(() => { expect(view.view.queryByText('excalidraw.saving')).toBeNull() })
  })
})

describe('ExcalidrawPanel model poll', () => {
  const loadedScene = { elements: [{ id: 'a', type: 'rectangle' }], appState: { viewBackgroundColor: '#fff' } }

  it('reloads the canvas when the model rewrites the scene file', async () => {
    sceneReply = reply(200, loadedScene)
    panel()
    await awaitCanvas()
    await waitFor(() => { expect(api.updateScene).toHaveBeenCalledTimes(1) })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    sceneReply = reply(200, { elements: [{ id: 'b', type: 'ellipse' }], appState: { viewBackgroundColor: '#eee' } })
    await firePoll()
    await waitFor(() => { expect(api.updateScene).toHaveBeenCalledTimes(2) })
    expect(api.updateScene).toHaveBeenLastCalledWith({
      elements: [{ id: 'b', type: 'ellipse' }],
      appState: { viewBackgroundColor: '#eee' },
    })
    expect(log).toHaveBeenCalled()
  })

  it('ignores unchanged, missing, failed, unreadable, and thrown polls silently', async () => {
    sceneReply = reply(200, loadedScene)
    const view = panel()
    await awaitCanvas()
    await waitFor(() => { expect(api.updateScene).toHaveBeenCalledTimes(1) })

    const tick = async (): Promise<void> => {
      await firePoll()
      expect(api.updateScene).toHaveBeenCalledTimes(1)
    }

    sceneReply = reply(404)
    await tick()

    sceneReply = reply(500, {})
    await tick()

    sceneReply = reply(200, {}, { jsonFails: true })
    await tick()

    sceneReply = reply(200, {}, { throws: new Error('offline') })
    await tick()

    sceneReply = reply(200, { elements: [{ id: 'a', type: 'rectangle' }], appState: { gridSize: 40 } })
    await tick()

    sceneReply = reply(200, { appState: {} })
    await tick()

    expect(view.view.queryByText('offline')).toBeNull()
  })
})

describe('ExcalidrawPanel theme', () => {
  it('follows the body dark-theme attribute', async () => {
    document.body.setAttribute('data-ds-dark-theme', '')
    const view = panel()
    await waitFor(() => {
      expect(view.view.getByTestId('excalidraw-canvas').getAttribute('data-theme')).toBe('dark')
    })

    act(() => { document.body.removeAttribute('data-ds-dark-theme') })
    await waitFor(() => {
      expect(view.view.getByTestId('excalidraw-canvas').getAttribute('data-theme')).toBe('light')
    })

    act(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    await waitFor(() => {
      expect(view.view.getByTestId('excalidraw-canvas').getAttribute('data-theme')).toBe('dark')
    })
  })
})

describe('ExcalidrawPanel export', () => {
  it('downloads a PNG named after the scene, with the view background', async () => {
    const downloads = stubDownloads()
    const anchors: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this)
    })
    const gated = deferred()
    const exportToBlob = vi.fn(async () => {
      await gated.promise
      return new Blob(['png'])
    })
    excalidraw.exportToBlob = exportToBlob
    api.getName.mockReturnValue('my-scene')

    const view = panel()
    await awaitCanvas()
    await waitFor(() => { expect((view.view.getByText('excalidraw.export') as HTMLButtonElement).disabled).toBe(false) })

    fireEvent.click(view.view.getByText('excalidraw.export'))
    await waitFor(() => { expect(exportToBlob).toHaveBeenCalledTimes(1) })
    expect(exportToBlob).toHaveBeenCalledWith({
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#fafafa' },
      files: {},
      mimeType: 'image/png',
      background: '#fafafa',
    })
    expect((view.view.getAllByText('excalidraw.exporting')[0] as HTMLButtonElement).disabled).toBe(true)

    gated.release()
    await waitFor(() => { expect(downloads.createObjectURL).toHaveBeenCalled() })
    expect(downloads.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(anchors[0]?.download).toBe('my-scene.png')
    expect(document.body.contains(anchors[0]!)).toBe(false)
    expect(view.view.getByText('excalidraw.export')).toBeDefined()

    fireTimeout(2000)
    expect(downloads.revokeObjectURL).toHaveBeenCalledWith('blob:fake')
  })

  it('downloads an SVG named canvas when the scene has no name', async () => {
    const downloads = stubDownloads()
    const anchors: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this)
    })
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '10')
    const exportToSvg = vi.fn(async () => svg)
    excalidraw.exportToSvg = exportToSvg
    api.getName.mockReturnValue('')
    api.getAppState.mockReturnValue({})

    const view = panel()
    await awaitCanvas()
    await waitFor(() => { expect((view.view.getByText('excalidraw.exportSvg') as HTMLButtonElement).disabled).toBe(false) })

    fireEvent.click(view.view.getByText('excalidraw.exportSvg'))
    await waitFor(() => { expect(downloads.createObjectURL).toHaveBeenCalled() })
    expect(exportToSvg).toHaveBeenCalledWith({
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: {},
      files: {},
      exportPadding: 10,
    })
    expect(anchors[0]?.download).toBe('canvas.svg')
    expect((downloads.createObjectURL.mock.calls[0]?.[0] as Blob).type).toBe('image/svg+xml;charset=utf-8')

    fireTimeout(2000)
    expect(downloads.revokeObjectURL).toHaveBeenCalledWith('blob:fake')
  })

  it('reports export failures from both formats and both rejection kinds', async () => {
    stubDownloads()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    excalidraw.exportToBlob = async () => { throw new Error('blob failed') }
    excalidraw.exportToSvg = async () => { throw 'svg boom' }
    const view = panel()
    await awaitCanvas()
    await waitFor(() => { expect((view.view.getByText('excalidraw.export') as HTMLButtonElement).disabled).toBe(false) })

    fireEvent.click(view.view.getByText('excalidraw.export'))
    await waitFor(() => { expect(view.view.getByText('blob failed')).toBeDefined() })

    fireEvent.click(view.view.getByText('excalidraw.exportSvg'))
    await waitFor(() => { expect(view.view.getByText('svg boom')).toBeDefined() })

    excalidraw.exportToBlob = async () => { throw 'png boom' }
    excalidraw.exportToSvg = async () => { throw new Error('svg failed') }
    fireEvent.click(view.view.getByText('excalidraw.export'))
    await waitFor(() => { expect(view.view.getByText('png boom')).toBeDefined() })

    fireEvent.click(view.view.getByText('excalidraw.exportSvg'))
    await waitFor(() => { expect(view.view.getByText('svg failed')).toBeDefined() })
  })

  it('names downloads from the scene and falls back to canvas', async () => {
    const downloads = stubDownloads()
    const anchors: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this)
    })
    const exportToBlob = vi.fn(async () => new Blob(['png']))
    excalidraw.exportToBlob = exportToBlob
    excalidraw.exportToSvg = async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    api.getAppState.mockReturnValue({})
    api.getName.mockReturnValue('')

    const view = panel()
    await awaitCanvas()
    await waitFor(() => { expect((view.view.getByText('excalidraw.export') as HTMLButtonElement).disabled).toBe(false) })

    fireEvent.click(view.view.getByText('excalidraw.export'))
    await waitFor(() => { expect(anchors).toHaveLength(1) })
    expect(exportToBlob).toHaveBeenCalledWith(expect.objectContaining({ background: '#ffffff' }))
    expect(anchors[0]?.download).toBe('canvas.png')

    api.getName.mockReturnValue('diagram')
    fireEvent.click(view.view.getByText('excalidraw.exportSvg'))
    await waitFor(() => { expect(anchors).toHaveLength(2) })
    expect(anchors[1]?.download).toBe('diagram.svg')

    // A non-string scene name falls back too.
    api.getName.mockReturnValue(undefined)
    fireEvent.click(view.view.getByText('excalidraw.exportSvg'))
    await waitFor(() => { expect(anchors).toHaveLength(3) })
    expect(anchors[2]?.download).toBe('canvas.svg')
    expect(downloads.createObjectURL).toHaveBeenCalledTimes(3)
  })

  it('keeps export disabled until the imperative API arrives', async () => {
    excalidraw.announceOnMount = false
    const view = panel()
    await awaitCanvas()

    const png = view.view.getByText('excalidraw.export') as HTMLButtonElement
    const svg = view.view.getByText('excalidraw.exportSvg') as HTMLButtonElement
    expect(png.disabled).toBe(true)
    expect(svg.disabled).toBe(true)
    expect(view.view.queryByText('excalidraw.canvasNotReady')).toBeNull()
  })

  it('reports a canvas that is no longer ready when the API is gone', async () => {
    const exportToBlob = vi.fn(async () => new Blob(['png']))
    const exportToSvg = vi.fn(async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    excalidraw.exportToBlob = exportToBlob
    excalidraw.exportToSvg = exportToSvg
    const view = panel()
    await awaitCanvas()
    await waitFor(() => { expect(currentCalls().length).toBeGreaterThanOrEqual(1) })

    // The canvas hands its API back while the panel keeps rendering.
    act(() => { canvasApiAnnouncement()(null) })
    fireEvent.click(view.view.getByText('excalidraw.export'))
    await waitFor(() => { expect(view.view.getByText('excalidraw.canvasNotReady')).toBeDefined() })
    fireEvent.click(view.view.getByText('excalidraw.exportSvg'))
    expect(view.view.getAllByText('excalidraw.canvasNotReady')).toHaveLength(1)

    expect(exportToBlob).not.toHaveBeenCalled()
    expect(exportToSvg).not.toHaveBeenCalled()
  })

  it('disables both export buttons while an export is still running', async () => {
    stubDownloads()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const gated = deferred()
    const exportToBlob = vi.fn(async () => {
      await gated.promise
      return new Blob(['png'])
    })
    const exportToSvg = vi.fn(async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    excalidraw.exportToBlob = exportToBlob
    excalidraw.exportToSvg = exportToSvg

    const view = panel()
    await awaitCanvas()
    await waitFor(() => { expect((view.view.getByText('excalidraw.export') as HTMLButtonElement).disabled).toBe(false) })

    fireEvent.click(view.view.getByText('excalidraw.export'))
    await waitFor(() => { expect(view.view.getAllByText('excalidraw.exporting')).toHaveLength(2) })

    // The disabled attribute keeps a queued second click from starting another export.
    fireEvent.click(view.view.getAllByText('excalidraw.exporting')[1] as HTMLButtonElement)
    await Promise.resolve()
    expect(exportToSvg).not.toHaveBeenCalled()

    gated.release()
    await waitFor(() => { expect(exportToBlob).toHaveBeenCalledTimes(1) })
    expect(exportToSvg).not.toHaveBeenCalled()
  })
})

describe('ExcalidrawPanel workspace changes and teardown', () => {
  it('reloads the scene when the workspace changes', async () => {
    sceneReply = reply(200, { elements: [{ id: 'a', type: 'rectangle' }], appState: {} })
    const view = panel({ items: [workspace('/one')] })
    await awaitCanvas()
    expect(currentCalls()[0]?.body).toEqual({ cwd: '/one' })

    sceneReply = reply(200, { elements: [{ id: 'b', type: 'ellipse' }], appState: { gridSize: 10 } })
    view.setWorkspaces([workspace('/two')])

    // The poll picks up the new workspace's file on its own.
    await waitFor(() => { expect(currentCalls().some(call => call.body['cwd'] === '/two')).toBe(true) })
    await waitFor(() => {
      expect(api.updateScene).toHaveBeenLastCalledWith({
        elements: [{ id: 'b', type: 'ellipse' }],
        appState: { gridSize: 10 },
      })
    })

    // The workspace reset makes the API re-announcement load the new scene.
    act(() => { canvasApiAnnouncement()(api) })
    await waitFor(() => {
      expect(currentCalls().filter(call => call.body['cwd'] === '/two').length).toBeGreaterThan(1)
    })
    expect(view.view.getByText('/two')).toBeDefined()
  })

  it('stops the poll and ignores a queued tick after unmount', async () => {
    const view = panel()
    await awaitCanvas()
    expect(currentCalls().length).toBeGreaterThanOrEqual(1)
    const before = fetchCalls.length
    const tick = pollTicks.at(-1)!

    view.view.unmount()
    expect(clearedIntervals).toHaveLength(1)

    // A tick that was already queued when the interval was cleared is inert.
    act(() => { tick() })
    expect(fetchCalls).toHaveLength(before)

    // The theme observer is disconnected too.
    act(() => { document.body.setAttribute('data-ds-dark-theme', '') })
  })
})
