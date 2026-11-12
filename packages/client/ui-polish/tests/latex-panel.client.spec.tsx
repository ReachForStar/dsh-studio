// @vitest-environment jsdom
/** LatexPanel: project discovery, the file tree and editor, compile and PDF
 * preview, the font manager, and the AI writing assistant. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'
import { LatexPanel, type LatexPanelProps } from '../src/client/LatexPanel.tsx'
import type { LatexFile, LatexProject } from '../src/client/latex-client.ts'

const t = makeTranslate(zh)

const WORKSPACE = '/ws'
const SESSION = 's-1'

const PROJECTS: readonly LatexProject[] = [
  { path: 'paper', name: 'paper', mainFiles: ['main.tex'] },
  { path: 'book', name: 'book', mainFiles: ['book.tex'] },
]

/** One JSON body or answer the panel's fetch calls carry. */
type Json = Record<string, unknown>
type Handler = (body: Json) => Response | Promise<Response>

/** Panels rendered with a session and the workspace that owns it. */
function panel(sessionId: string | undefined, workspacePath: string | undefined, owner = sessionId) {
  const items = workspacePath === undefined
    ? []
    : [{ workspaceId: 'w-1', title: 'workspace', path: workspacePath, sessionIds: [owner ?? SESSION] }]
  const props = {
    useSession: (selector: (state: { sessionId: string | undefined }) => unknown) => selector({ sessionId }),
    useWorkspaces: (selector: (state: { items: unknown[] }) => unknown) => selector({ items }),
    t,
  } as unknown as LatexPanelProps
  return <LatexPanel {...props} />
}

function renderPanel(sessionId: string = SESSION, workspacePath: string = WORKSPACE) {
  return render(panel(sessionId, workspacePath))
}

function editor(): HTMLTextAreaElement {
  const element = document.querySelector('main textarea')
  if (element === null) throw new Error('the editor is not rendered')
  return element as HTMLTextAreaElement
}

function projectSelect(): HTMLSelectElement {
  return document.querySelector(`select[title="${t('latex.project')}"]`) as HTMLSelectElement
}

function mainSelect(): HTMLSelectElement {
  return document.querySelector(`select[title="${t('latex.mainFile')}"]`) as HTMLSelectElement
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

function checkbox(): HTMLInputElement {
  return screen.getByRole('checkbox') as HTMLInputElement
}

function modelSelect(): HTMLSelectElement {
  return screen.getByTitle(t('latex.aiModel')) as HTMLSelectElement
}

function treeItem(path: string): HTMLElement | null {
  return document.querySelector(`li[title="${path}"]`)
}

function aiInput(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(t('latex.aiPlaceholder')) as HTMLTextAreaElement
}

function modalBody(): HTMLElement {
  return screen.getByText(`✦ ${t('latex.aiTitle')}`).parentElement as HTMLElement
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

/** Streaming response double over pre-chunked NDJSON text. */
function streamResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
  } as unknown as Response
}

/** A stream whose chunks the test pushes while the request stays open. */
function controlledStream(): { response: Response; send: (line: string) => void; close: () => void } {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({ start(next) { controller = next } })
  return {
    response: { ok: true, status: 200, body } as unknown as Response,
    send: (line: string) => { controller?.enqueue(encoder.encode(`${line}\n`)) },
    close: () => { controller?.close() },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** Flush pending promise chains inside an act scope. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
  })
}

const FAILURES: readonly (readonly [string, () => Error | string])[] = [
  ['an Error', () => new Error('boom')],
  ['a non-Error', () => 'boom'],
]

function failing(make: () => Error | string): Handler {
  return () => { throw make() }
}

let routes: Record<string, Handler> = {}
let calls: { url: string; body: Json }[] = []
let filesByDir: Record<string, LatexFile[]> = {}
let contents: Record<string, string> = {}
let promptMock: ReturnType<typeof vi.fn>

/** Native timer captured before the notice-timeout stub replaces it. */
const nativeSetTimeout = globalThis.setTimeout

function callsFor(url: string): { url: string; body: Json }[] {
  return calls.filter(call => call.url === url)
}

function defaultRoutes(): Record<string, Handler> {
  return {
    '/latex/projects': () => jsonResponse(200, { projects: PROJECTS }),
    '/latex/list': body => jsonResponse(200, { files: filesByDir[String(body.dir)] ?? [] }),
    '/latex/read': body => jsonResponse(200, { content: contents[String(body.path)] ?? '' }),
    '/latex/write': (body) => {
      const dir = String(body.dir)
      const path = String(body.path)
      const text = String(body.content)
      contents[path] = text
      const tree = filesByDir[dir] ?? []
      if (!tree.some(file => file.path === path)) {
        filesByDir[dir] = [...tree, { path, size: text.length, dir: false }]
      }
      return jsonResponse(200, { ok: true })
    },
    '/latex/compile': () => jsonResponse(200, { ok: true, size: 10 }),
    '/latex/clean': () => jsonResponse(200, { ok: true, removed: 2 }),
    '/latex/fonts': (body) => {
      if (body.op === 'install') return jsonResponse(200, { ok: true, path: 'fonts/installed.ttf' })
      if (body.op === 'install-package') return jsonResponse(200, { ok: true, log: 'tlmgr installed ctex' })
      return jsonResponse(200, {
        fonts: ['Source Han Sans'],
        packages: { ctex: true, xecjk: true, fandol: true },
      })
    },
    '/latex/models': () => jsonResponse(200, {
      models: [{ provider: 'deepseek', model: 'chat', name: 'DeepSeek Chat' }],
    }),
    '/latex/ai': () => streamResponse(['{"t":"text","x":"refined"}\n', '{"t":"done","m":"refined"}\n']),
    '/latex/ai-cancel': () => jsonResponse(200, { ok: true }),
  }
}

beforeEach(() => {
  filesByDir = {
    paper: [
      { path: 'chapters', size: 0, dir: true },
      { path: 'main.tex', size: 12, dir: false },
      { path: 'notes.md', size: 4, dir: false },
    ],
    book: [{ path: 'book.tex', size: 5, dir: false }],
  }
  contents = {
    'main.tex': '\\documentclass{article}',
    'book.tex': '\\book',
    'notes.md': '# notes',
  }
  routes = defaultRoutes()
  calls = []
  promptMock = vi.fn(() => null)
  window.localStorage.clear()
  vi.stubGlobal('prompt', promptMock)
  // The notice timer outlives each test's tree; only the dedicated fake-timer
  // case needs it to fire, so the 2500 ms arm is dropped here.
  vi.stubGlobal('setTimeout', (handler: () => void, delay?: number, ...args: unknown[]) =>
    delay === 2500 ? 0 : nativeSetTimeout(handler, delay, ...args))
  // jsdom has no animation frames; the editor's Tab handler needs one to run.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body: Json = typeof init?.body === 'string' ? JSON.parse(init.body) as Json : {}
    calls.push({ url, body })
    const handler = routes[url]
    if (handler === undefined) throw new Error(`unexpected request: ${url}`)
    return handler(body)
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('LatexPanel workspace selection', () => {
  it('asks for a workspace when the session is unset', () => {
    render(panel(undefined, WORKSPACE))
    expect(screen.getByText(t('latex.noWorkspace'))).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('asks for a workspace when no workspace owns the session', () => {
    render(panel('s-2', WORKSPACE, 's-1'))
    expect(screen.getByText(t('latex.noWorkspace'))).toBeTruthy()
    expect(calls).toHaveLength(0)
  })
})

describe('LatexPanel project discovery', () => {
  it('opens the first project and its main file', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    expect(projectSelect().value).toBe('paper')
    expect(mainSelect().value).toBe('main.tex')
    expect(screen.getByText('chapters/')).toBeTruthy()
    expect(callsFor('/latex/read')[0]?.body).toMatchObject({ cwd: WORKSPACE, dir: 'paper', path: 'main.tex' })
    expect(treeItem('main.tex')?.getAttribute('data-current')).toBe('1')
    expect(treeItem('chapters')?.getAttribute('data-current')).toBeNull()
    expect(treeItem('chapters')?.textContent).toBe('chapters/')
  })

  it('falls back to the workspace root when no project is discovered', async () => {
    routes['/latex/projects'] = () => jsonResponse(200, { projects: [] })
    renderPanel()
    await waitFor(() => { expect(projectSelect().value).toBe('.') })
    expect(screen.getByText(t('latex.rootProject'))).toBeTruthy()
    expect(screen.getByText(t('latex.noFiles'))).toBeTruthy()
    expect(screen.getByText(t('latex.pickFile'))).toBeTruthy()
    expect(mainSelect().disabled).toBe(true)
    expect(button(t('latex.compile')).disabled).toBe(true)
    fireEvent.click(button(t('latex.newFile')))
    fireEvent.click(button(t('latex.clean')))
    await flush()
    expect(promptMock).not.toHaveBeenCalled()
    expect(callsFor('/latex/clean')).toHaveLength(0)
    expect(callsFor('/latex/write')).toHaveLength(0)
  })

  it.each(FAILURES)('reports a failed project discovery with %s', async (_kind, make) => {
    routes['/latex/projects'] = failing(make)
    renderPanel()
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() })
  })

  it('ignores project discovery that resolves after unmount', async () => {
    const gate = deferred<Response>()
    routes['/latex/projects'] = () => gate.promise
    const view = renderPanel()
    view.unmount()
    await act(async () => {
      gate.resolve(jsonResponse(200, { projects: PROJECTS }))
      await Promise.resolve()
    })
    expect(callsFor('/latex/list')).toHaveLength(0)
  })

  it('ignores project discovery failures that arrive after unmount', async () => {
    const gate = deferred<Response>()
    routes['/latex/projects'] = () => gate.promise
    const view = renderPanel()
    view.unmount()
    await act(async () => {
      gate.reject(new Error('late'))
      await Promise.resolve()
    })
    expect(callsFor('/latex/list')).toHaveLength(0)
  })

  it('keeps the selected project when the workspace changes', async () => {
    const view = renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    view.rerender(panel(SESSION, '/ws2'))
    await waitFor(() => { expect(callsFor('/latex/projects')).toHaveLength(2) })
    expect(callsFor('/latex/projects')[1]?.body.cwd).toBe('/ws2')
    expect(callsFor('/latex/list')).toHaveLength(1)
    expect(projectSelect().value).toBe('paper')
  })

  it('switches projects and adopts the new main file', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.change(projectSelect(), { target: { value: 'book' } })
    await waitFor(() => { expect(editor().value).toBe(contents['book.tex'] as string) })
    expect(mainSelect().value).toBe('book.tex')
    expect(callsFor('/latex/read')[1]?.body).toMatchObject({ dir: 'book', path: 'book.tex' })
  })

  it('clears the main file when the next project has none', async () => {
    filesByDir.book = [
      { path: 'figures', size: 0, dir: true },
      { path: 'notes.md', size: 1, dir: false },
    ]
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.change(projectSelect(), { target: { value: 'book' } })
    await waitFor(() => { expect(screen.getByText('figures/')).toBeTruthy() })
    expect(mainSelect().value).toBe('')
    expect(button(t('latex.compile')).disabled).toBe(true)
    expect(screen.getByText(t('latex.noPdf'))).toBeTruthy()
  })

  it.each(FAILURES)('reports a failed project listing with %s', async (_kind, make) => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    routes['/latex/list'] = failing(make)
    fireEvent.change(projectSelect(), { target: { value: 'book' } })
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() })
    expect(button(t('latex.compile')).disabled).toBe(true)
  })
})

describe('LatexPanel editor', () => {
  it('opens another file from the tree', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(treeItem('notes.md') as HTMLElement)
    await waitFor(() => { expect(editor().value).toBe(contents['notes.md'] as string) })
    expect(treeItem('notes.md')?.getAttribute('data-current')).toBe('1')
    expect(callsFor('/latex/read')[1]?.body).toMatchObject({ path: 'notes.md' })
  })

  it.each(FAILURES)('reports a failed file read with %s', async (_kind, make) => {
    routes['/latex/read'] = failing(make)
    renderPanel()
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() })
  })

  it('numbers one gutter line per logical line', async () => {
    contents['main.tex'] = 'first\nsecond\nthird'
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe('first\nsecond\nthird') })
    expect(document.querySelector('pre')?.textContent).toBe('1\n2\n3')
  })

  it('saves with Ctrl+S and auto-compiles', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.change(editor(), { target: { value: 'changed' } })
    expect(screen.getByText('●')).toBeTruthy()
    fireEvent.keyDown(editor(), { key: 's', ctrlKey: true })
    await waitFor(() => { expect(callsFor('/latex/write')).toHaveLength(1) })
    expect(callsFor('/latex/write')[0]?.body).toMatchObject({ dir: 'paper', path: 'main.tex', content: 'changed' })
    await waitFor(() => { expect(screen.queryByText('●')).toBeNull() })
    await waitFor(() => { expect(callsFor('/latex/compile')).toHaveLength(1) })
  })

  it('saves with Cmd+S and skips the compile when auto-compile is off', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(editor(), { target: { value: 'changed' } })
    fireEvent.keyDown(editor(), { key: 's', metaKey: true })
    await waitFor(() => { expect(callsFor('/latex/write')).toHaveLength(1) })
    await flush()
    expect(callsFor('/latex/compile')).toHaveLength(0)
  })

  it('leaves an unchanged file unsaved and ignores unrelated shortcuts', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.keyDown(editor(), { key: 's', ctrlKey: true })
    fireEvent.keyDown(editor(), { key: 'a', ctrlKey: true })
    await flush()
    expect(callsFor('/latex/write')).toHaveLength(0)
    expect(callsFor('/latex/compile')).toHaveLength(0)
  })

  it('saves through the toolbar button', async () => {    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.change(editor(), { target: { value: 'toolbar' } })
    fireEvent.click(button(t('latex.save')))
    await waitFor(() => { expect(callsFor('/latex/write')).toHaveLength(1) })
  })

  it.each(FAILURES)('reports a failed save with %s', async (_kind, make) => {
    routes['/latex/write'] = failing(make)
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.change(editor(), { target: { value: 'changed' } })
    fireEvent.click(button(t('latex.save')))
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() })
    expect(screen.getByText('●')).toBeTruthy()
  })

  it('persists the auto-compile toggle', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    const toggle = checkbox()
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    expect(window.localStorage.getItem('dsh-latex-auto')).toBe('0')
    expect(checkbox().checked).toBe(false)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(window.localStorage.getItem('dsh-latex-auto')).toBe('1')
  })

  it('keeps the auto-compile toggle usable when storage refuses writes', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(checkbox().checked).toBe(false)
  })

  it('starts with auto-compile on when storage refuses reads', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    renderPanel()
    expect(checkbox().checked).toBe(true)
  })

  it('inserts two spaces on Tab and leaves other keys alone', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.change(editor(), { target: { value: 'ab' } })
    const box = editor()
    box.setSelectionRange(1, 1)
    fireEvent.keyUp(box, { key: 'Tab' })
    await waitFor(() => { expect(editor().value).toBe('a  b') })
    fireEvent.keyUp(editor(), { key: 'a' })
    expect(editor().value).toBe('a  b')
  })

  it('synchronizes the gutter while the editor scrolls', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    const box = editor()
    box.scrollTop = 42
    fireEvent.scroll(box)
    expect(document.querySelector('pre')?.scrollTop).toBe(42)
  })

  it('switches the compile target through the main-file picker', async () => {
    filesByDir.paper = [
      { path: 'main.tex', size: 1, dir: false },
      { path: 'appendix.tex', size: 1, dir: false },
    ]
    contents['appendix.tex'] = '\\appendix'
    renderPanel()
    await waitFor(() => { expect(mainSelect().value).toBe('main.tex') })
    fireEvent.change(mainSelect(), { target: { value: 'appendix.tex' } })
    fireEvent.click(button(t('latex.compile')))
    await waitFor(() => { expect(callsFor('/latex/compile')).toHaveLength(1) })
    expect(callsFor('/latex/compile')[0]?.body).toMatchObject({ main: 'appendix.tex' })
  })

  it('saves without a main file and therefore compiles nothing', async () => {
    filesByDir.paper = [{ path: 'notes.md', size: 1, dir: false }]
    renderPanel()
    await waitFor(() => { expect(screen.getByText('notes.md')).toBeTruthy() })
    fireEvent.click(treeItem('notes.md') as HTMLElement)
    await waitFor(() => { expect(editor().value).toBe(contents['notes.md'] as string) })
    fireEvent.change(editor(), { target: { value: 'edited' } })
    fireEvent.click(button(t('latex.save')))
    await waitFor(() => { expect(callsFor('/latex/write')).toHaveLength(1) })
    await flush()
    expect(callsFor('/latex/compile')).toHaveLength(0)
  })
})

describe('LatexPanel compile and preview', () => {
  it('compiles, reports supplied graphics, and reloads the preview', async () => {
    routes['/latex/compile'] = () => jsonResponse(200, { ok: true, supplied: ['fig.png'] })
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(t('latex.compile')))
    await waitFor(() => { expect(screen.getByText(t('latex.suppliedGraphics', { n: 1 }))).toBeTruthy() })
    expect(document.querySelector('iframe')?.getAttribute('src'))
      .toBe('/latex/pdf?cwd=%2Fws&dir=paper&main=main.tex&t=1')
    fireEvent.click(screen.getByTitle(t('latex.reload')))
    await waitFor(() => {
      expect(document.querySelector('iframe')?.getAttribute('src'))
        .toBe('/latex/pdf?cwd=%2Fws&dir=paper&main=main.tex&t=2')
    })
  })

  it('reports a plain compile and clears the notice after its timeout', async () => {
    vi.useFakeTimers()
    try {
      renderPanel()
      await flush()
      fireEvent.click(button(t('latex.compile')))
      await flush()
      expect(screen.getByText(t('latex.compiled'))).toBeTruthy()
      await act(async () => { vi.advanceTimersByTime(2600) })
      expect(screen.queryByText(t('latex.compiled'))).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the compiler log when the build fails', async () => {
    const log = "LaTeX Warning: Reference `sec:intro' on page 1 undefined"
    routes['/latex/compile'] = () => jsonResponse(200, { ok: false, log })
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(t('latex.compile')))
    await waitFor(() => { expect(screen.getByText(log)).toBeTruthy() })
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('shows a placeholder when a failed build carries no log', async () => {
    routes['/latex/compile'] = () => jsonResponse(200, { ok: false })
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(t('latex.compile')))
    await waitFor(() => { expect(screen.getByText('—')).toBeTruthy() })
  })

  it.each(FAILURES)('reports a failed compile call with %s', async (_kind, make) => {
    routes['/latex/compile'] = failing(make)
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(t('latex.compile')))
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() })
  })

  it('shows the compiling state until the build answers', async () => {
    const gate = deferred<Response>()
    routes['/latex/compile'] = () => gate.promise
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(t('latex.compile')))
    await waitFor(() => { expect(button(t('latex.compiling')).disabled).toBe(true) })
    await act(async () => {
      gate.resolve(jsonResponse(200, { ok: true }))
      await Promise.resolve()
    })
    await waitFor(() => { expect(screen.getByText(t('latex.compiled'))).toBeTruthy() })
  })
})

describe('LatexPanel project maintenance', () => {
  it('creates a file through the prompt and opens it', async () => {
    promptMock.mockReturnValue('chapter.tex')
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(t('latex.newFile')))
    await waitFor(() => { expect(editor().value).toBe('') })
    expect(callsFor('/latex/write')[0]?.body).toMatchObject({ dir: 'paper', path: 'chapter.tex', content: '' })
    expect(mainSelect().value).toBe('chapter.tex')
    expect(treeItem('chapter.tex')).not.toBeNull()
    expect(document.querySelector('main pre')?.textContent).toBe('1')
  })

  it('creates nothing when the prompt is cancelled or blank', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    promptMock.mockReturnValue(null)
    fireEvent.click(button(t('latex.newFile')))
    await flush()
    promptMock.mockReturnValue('   ')
    fireEvent.click(button(t('latex.newFile')))
    await flush()
    expect(callsFor('/latex/write')).toHaveLength(0)
  })

  it.each(FAILURES)('reports a failed file creation with %s', async (_kind, make) => {
    promptMock.mockReturnValue('chapter.tex')
    routes['/latex/write'] = failing(make)
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(t('latex.newFile')))
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() })
  })

  it('cleans build leftovers and reports the count', async () => {
    routes['/latex/clean'] = () => jsonResponse(200, { ok: true, removed: 4 })
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(t('latex.clean')))
    await waitFor(() => { expect(screen.getByText(t('latex.cleaned', { n: 4 }))).toBeTruthy() })
    expect(callsFor('/latex/clean')[0]?.body).toMatchObject({ cwd: WORKSPACE, dir: 'paper' })
  })

  it.each(FAILURES)('reports a failed clean with %s', async (_kind, make) => {
    routes['/latex/clean'] = failing(make)
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(t('latex.clean')))
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() })
  })
})

describe('LatexPanel AI writing assistant', () => {
  it('has nothing to apply before a result exists', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    const apply = button(t('latex.aiApply'))
    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)
    expect(screen.getByText(`✦ ${t('latex.aiTitle')}`)).toBeTruthy()
    expect(editor().value).toBe(contents['main.tex'] as string)
  })

  it('opens without a selection and replaces the whole file', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    expect(screen.getByText(`✦ ${t('latex.aiTitle')}`)).toBeTruthy()
    expect(screen.queryByText(t('latex.aiSelectionMode'))).toBeNull()
    fireEvent.change(aiInput(), { target: { value: 'tighten' } })
    fireEvent.click(button(t('latex.aiRun')))
    await waitFor(() => { expect(screen.getByText('refined')).toBeTruthy() })
    fireEvent.click(button(t('latex.aiApply')))
    expect(editor().value).toBe('refined')
    expect(screen.getByText('●')).toBeTruthy()
    expect(screen.queryByText(`✦ ${t('latex.aiTitle')}`)).toBeNull()
    expect(callsFor('/latex/ai')[0]?.body).toMatchObject({ dir: 'paper', path: 'main.tex', instruction: 'tighten' })
    expect(callsFor('/latex/ai')[0]?.body).not.toHaveProperty('selection')
    expect(callsFor('/latex/ai')[0]?.body).not.toHaveProperty('model')
  })

  it('rewrites the captured selection in place', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.change(editor(), { target: { value: 'alpha beta' } })
    editor().setSelectionRange(0, 5)
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    expect(screen.getByText(t('latex.aiSelectionMode'))).toBeTruthy()
    fireEvent.change(aiInput(), { target: { value: 'tighten' } })
    fireEvent.click(button(t('latex.aiRun')))
    await waitFor(() => { expect(screen.getByText('refined')).toBeTruthy() })
    expect(callsFor('/latex/ai')[0]?.body.selection).toBe('alpha')
    fireEvent.click(button(t('latex.aiApply')))
    expect(editor().value).toBe('refined beta')
  })

  it('replaces the file when the captured selection collapsed before applying', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.change(editor(), { target: { value: 'alpha beta' } })
    editor().setSelectionRange(0, 5)
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    fireEvent.change(aiInput(), { target: { value: 'tighten' } })
    fireEvent.click(button(t('latex.aiRun')))
    await waitFor(() => { expect(screen.getByText('refined')).toBeTruthy() })
    editor().setSelectionRange(2, 2)
    fireEvent.click(button(t('latex.aiApply')))
    expect(editor().value).toBe('refined')
  })

  it('lists models, remembers the choice, and sends it with the turn', async () => {
    window.localStorage.setItem('dsh-latex-ai-model', 'deepseek/chat')
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    const picker = screen.getByTitle(t('latex.aiModel')) as HTMLSelectElement
    await waitFor(() => { expect(screen.getByRole('option', { name: 'DeepSeek Chat (deepseek)' })).toBeTruthy() })
    expect(picker.value).toBe('deepseek/chat')
    fireEvent.change(picker, { target: { value: '' } })
    expect(window.localStorage.getItem('dsh-latex-ai-model')).toBeNull()
    fireEvent.change(picker, { target: { value: 'deepseek/chat' } })
    expect(window.localStorage.getItem('dsh-latex-ai-model')).toBe('deepseek/chat')
    fireEvent.change(aiInput(), { target: { value: 'go' } })
    fireEvent.click(button(t('latex.aiRun')))
    await waitFor(() => { expect(callsFor('/latex/ai')).toHaveLength(1) })
    expect(callsFor('/latex/ai')[0]?.body.model).toBe('deepseek/chat')
  })

  it('keeps the model choice when storage refuses writes', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    await waitFor(() => { expect(screen.getByRole('option', { name: 'DeepSeek Chat (deepseek)' })).toBeTruthy() })
    const picker = screen.getByTitle(t('latex.aiModel')) as HTMLSelectElement
    fireEvent.change(picker, { target: { value: 'deepseek/chat' } })
    expect(picker.value).toBe('deepseek/chat')
  })

  it('starts with the default model when storage refuses reads', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    expect(modelSelect().value).toBe('')
  })

  it('falls back to the default model when the catalog fails', async () => {
    routes['/latex/models'] = failing(() => new Error('no llm'))
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    await flush()
    expect(modelSelect().options).toHaveLength(1)
  })

  it('ignores a model catalog that answers after the dialog closes', async () => {
    const gate = deferred<Response>()
    routes['/latex/models'] = () => gate.promise
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    fireEvent.click(button(t('latex.close')))
    await act(async () => {
      gate.resolve(jsonResponse(200, { models: [] }))
      await Promise.resolve()
    })
    expect(screen.queryByText(`✦ ${t('latex.aiTitle')}`)).toBeNull()
  })

  it('ignores a model catalog failure after the dialog closes', async () => {
    const gate = deferred<Response>()
    routes['/latex/models'] = () => gate.promise
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    fireEvent.click(button(t('latex.close')))
    await act(async () => {
      gate.reject(new Error('late'))
      await Promise.resolve()
    })
    expect(screen.queryByText(`✦ ${t('latex.aiTitle')}`)).toBeNull()
  })

  it('streams deltas into the assistant turn', async () => {
    const stream = controlledStream()
    routes['/latex/ai'] = () => stream.response
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    fireEvent.change(aiInput(), { target: { value: 'go' } })
    fireEvent.click(button(t('latex.aiRun')))
    await waitFor(() => { expect(screen.getByText(t('latex.aiRunning'))).toBeTruthy() })
    await act(async () => { stream.send('{"t":"text","x":"A"}'); await Promise.resolve() })
    await waitFor(() => { expect(screen.getByText('A')).toBeTruthy() })
    await act(async () => { stream.send('{"t":"text","x":"B"}'); await Promise.resolve() })
    await waitFor(() => { expect(screen.getByText('AB')).toBeTruthy() })
    await act(async () => {
      stream.send('{"t":"done","m":"AB"}')
      stream.close()
      await Promise.resolve()
    })
    await waitFor(() => { expect(button(t('latex.aiApply')).disabled).toBe(false) })
  })

  it('stops a running turn and keeps the partial answer', async () => {
    const stream = controlledStream()
    routes['/latex/ai'] = () => stream.response
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    fireEvent.change(aiInput(), { target: { value: 'go' } })
    fireEvent.click(button(t('latex.aiRun')))
    fireEvent.click(await screen.findByRole('button', { name: t('latex.aiStop') }))
    await waitFor(() => { expect(callsFor('/latex/ai-cancel')).toHaveLength(1) })
    expect(typeof callsFor('/latex/ai-cancel')[0]?.body.token).toBe('string')
    await act(async () => {
      stream.send('{"t":"text","x":"part"}')
      stream.send('{"t":"stop"}')
      stream.close()
      await Promise.resolve()
    })
    await waitFor(() => { expect(screen.queryByRole('button', { name: t('latex.aiStop') })).toBeNull() })
    expect(screen.getByText('part')).toBeTruthy()
  })

  it.each(FAILURES)('reports a failed turn with %s and drops the empty placeholder', async (_kind, make) => {
    routes['/latex/ai'] = failing(make)
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    fireEvent.change(aiInput(), { target: { value: 'go' } })
    fireEvent.click(button(t('latex.aiRun')))
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() })
    expect(button(t('latex.aiApply')).disabled).toBe(true)
    expect(document.querySelectorAll('[data-ai-turn]')).toHaveLength(1)
  })

  it('keeps a partial answer when the stream fails after deltas', async () => {
    const stream = controlledStream()
    routes['/latex/ai'] = () => stream.response
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    fireEvent.change(aiInput(), { target: { value: 'go' } })
    fireEvent.click(button(t('latex.aiRun')))
    await act(async () => {
      stream.send('{"t":"text","x":"half"}')
      stream.send('{"t":"err","e":"quota"}')
      stream.close()
      await Promise.resolve()
    })
    await waitFor(() => { expect(screen.getByText('quota')).toBeTruthy() })
    expect(screen.getByText('half')).toBeTruthy()
    expect(document.querySelectorAll('[data-ai-turn]')).toHaveLength(2)
  })

  it('ignores blank instructions and repeated submissions', async () => {
    const stream = controlledStream()
    routes['/latex/ai'] = () => stream.response
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    fireEvent.change(aiInput(), { target: { value: '   ' } })
    fireEvent.keyDown(aiInput(), { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(aiInput(), { key: 'Enter' })
    await flush()
    expect(callsFor('/latex/ai')).toHaveLength(0)
    fireEvent.change(aiInput(), { target: { value: 'go' } })
    fireEvent.keyDown(aiInput(), { key: 'Enter', ctrlKey: true })
    await waitFor(() => { expect(callsFor('/latex/ai')).toHaveLength(1) })
    fireEvent.keyDown(aiInput(), { key: 'Enter', metaKey: true })
    await flush()
    expect(callsFor('/latex/ai')).toHaveLength(1)
    await act(async () => {
      stream.send('{"t":"stop"}')
      stream.close()
      await Promise.resolve()
    })
    await waitFor(() => { expect(screen.queryByRole('button', { name: t('latex.aiStop') })).toBeNull() })
  })

  it('sends earlier turns as history for a follow-up', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    fireEvent.change(aiInput(), { target: { value: 'first' } })
    fireEvent.click(button(t('latex.aiRun')))
    await waitFor(() => { expect(screen.getByText('refined')).toBeTruthy() })
    fireEvent.change(aiInput(), { target: { value: 'second' } })
    fireEvent.click(button(t('latex.aiRun')))
    await waitFor(() => { expect(callsFor('/latex/ai')).toHaveLength(2) })
    expect(callsFor('/latex/ai')[1]?.body.history).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'refined' },
    ])
  })

  it('closes through the Close button, the backdrop, and keeps clicks inside', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    fireEvent.click(modalBody())
    expect(screen.getByText(`✦ ${t('latex.aiTitle')}`)).toBeTruthy()
    fireEvent.click(modalBody().parentElement as HTMLElement)
    expect(screen.queryByText(`✦ ${t('latex.aiTitle')}`)).toBeNull()
    fireEvent.click(button(`✦ ${t('latex.ai')}`))
    fireEvent.click(button(t('latex.close')))
    expect(screen.queryByText(`✦ ${t('latex.aiTitle')}`)).toBeNull()
  })
})

describe('LatexPanel font manager', () => {
  function openFonts(): void {
    fireEvent.click(button(t('latex.fonts')))
  }

  it('lists installed fonts and TeX package availability', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    openFonts()
    await waitFor(() => { expect(screen.getByText('Source Han Sans')).toBeTruthy() })
    expect(screen.getByText(t('latex.pkgCtex'))).toBeTruthy()
    expect(screen.getByText(t('latex.pkgXecjk'))).toBeTruthy()
    expect(screen.getByText(t('latex.pkgFandol'))).toBeTruthy()
    expect(callsFor('/latex/fonts')[0]?.body).toMatchObject({ dir: 'paper', op: 'list' })
  })

  it('shows missing fonts and packages', async () => {
    routes['/latex/fonts'] = body => body.op === 'list'
      ? jsonResponse(200, { fonts: [], packages: { ctex: false, xecjk: false, fandol: false } })
      : jsonResponse(200, { ok: true })
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    openFonts()
    await waitFor(() => { expect(screen.getByText(t('latex.noFonts'))).toBeTruthy() })
    expect(screen.getByText(t('latex.pkgCtex'))).toBeTruthy()
  })

  it.each(FAILURES)('reports a failed font listing with %s', async (_kind, make) => {
    routes['/latex/fonts'] = failing(make)
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    openFonts()
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() })
  })

  it('installs a font file and refreshes the list', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    openFonts()
    await waitFor(() => { expect(screen.getByText('Source Han Sans')).toBeTruthy() })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const openPicker = vi.spyOn(input, 'click')
    fireEvent.click(button(t('latex.fontUpload')))
    expect(openPicker).toHaveBeenCalledTimes(1)
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1, 2, 3])], 'my.ttf', { type: 'font/ttf' })] },
    })
    await waitFor(() => {
      expect(callsFor('/latex/fonts').some(call => call.body.op === 'install')).toBe(true)
    })
    const install = callsFor('/latex/fonts').find(call => call.body.op === 'install')
    expect(install?.body).toMatchObject({ dir: 'paper', name: 'my.ttf' })
    expect(typeof install?.body.data).toBe('string')
    await waitFor(() => {
      expect(callsFor('/latex/fonts').filter(call => call.body.op === 'list')).toHaveLength(2)
    })
  })

  it('ignores a file input change with no file', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    openFonts()
    await waitFor(() => { expect(screen.getByText('Source Han Sans')).toBeTruthy() })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [] } })
    await flush()
    expect(callsFor('/latex/fonts').some(call => call.body.op === 'install')).toBe(false)
  })

  it('rejects a font file the reader returns as bytes', async () => {
    class BytesReader {
      result: ArrayBuffer | null = null
      onload: (() => void) | null = null
      readAsDataURL(): void {
        this.result = new ArrayBuffer(1)
        this.onload?.()
      }
    }
    vi.stubGlobal('FileReader', BytesReader)
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    openFonts()
    await waitFor(() => { expect(screen.getByText('Source Han Sans')).toBeTruthy() })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'bad.ttf')] } })
    await waitFor(() => { expect(screen.getByText(/could not be read/)).toBeTruthy() })
  })

  it.each(FAILURES)('reports a failed font install with %s', async (_kind, make) => {
    routes['/latex/fonts'] = (body) => {
      if (body.op === 'install') throw make()
      return jsonResponse(200, { fonts: [], packages: { ctex: false, xecjk: false, fandol: false } })
    }
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    openFonts()
    await waitFor(() => { expect(screen.getByText(t('latex.noFonts'))).toBeTruthy() })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'bad.ttf')] } })
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() })
  })

  it('disables the upload while the install is pending', async () => {
    const gate = deferred<Response>()
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    openFonts()
    await waitFor(() => { expect(screen.getByText('Source Han Sans')).toBeTruthy() })
    routes['/latex/fonts'] = body => body.op === 'install'
      ? gate.promise
      : jsonResponse(200, { fonts: [], packages: { ctex: false, xecjk: false, fandol: false } })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'pending.ttf')] } })
    await waitFor(() => { expect(button(t('latex.fontUpload')).disabled).toBe(true) })
    await act(async () => {
      gate.resolve(jsonResponse(200, { ok: true }))
      await Promise.resolve()
    })
    await waitFor(() => { expect(button(t('latex.fontUpload')).disabled).toBe(false) })
  })

  it('installs a TeX package and shows the tlmgr log', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    openFonts()
    await waitFor(() => { expect(screen.getByText('Source Han Sans')).toBeTruthy() })
    const input = screen.getByPlaceholderText(t('latex.pkgPlaceholder'))
    fireEvent.change(input, { target: { value: '  ctex  ' } })
    fireEvent.click(button(t('latex.pkgInstall')))
    await waitFor(() => { expect(screen.getByText('tlmgr installed ctex')).toBeTruthy() })
    expect(callsFor('/latex/fonts').some(call => call.body.op === 'install-package' && call.body.name === 'ctex')).toBe(true)
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('installs a TeX package from the Enter key', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    openFonts()
    await waitFor(() => { expect(screen.getByText('Source Han Sans')).toBeTruthy() })
    const input = screen.getByPlaceholderText(t('latex.pkgPlaceholder'))
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'a' })
    await flush()
    expect(callsFor('/latex/fonts').some(call => call.body.op === 'install-package')).toBe(false)
    fireEvent.change(input, { target: { value: 'fandol' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByText('tlmgr installed ctex')).toBeTruthy() })
    expect(callsFor('/latex/fonts').some(call => call.body.op === 'install-package' && call.body.name === 'fandol')).toBe(true)
  })

  it.each(FAILURES)('reports a failed package install with %s', async (_kind, make) => {
    routes['/latex/fonts'] = (body) => {
      if (body.op === 'install-package') throw make()
      return jsonResponse(200, { fonts: [], packages: { ctex: false, xecjk: false, fandol: false } })
    }
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    openFonts()
    await waitFor(() => { expect(screen.getByText(t('latex.noFonts'))).toBeTruthy() })
    const input = screen.getByPlaceholderText(t('latex.pkgPlaceholder'))
    fireEvent.change(input, { target: { value: 'ctex' } })
    fireEvent.click(button(t('latex.pkgInstall')))
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() })
  })

  it('closes through the Close button, the backdrop, and keeps clicks inside', async () => {
    renderPanel()
    await waitFor(() => { expect(editor().value).toBe(contents['main.tex'] as string) })
    openFonts()
    const title = await screen.findByText(t('latex.fontsTitle'))
    const modal = title.parentElement as HTMLElement
    fireEvent.click(modal)
    expect(screen.getByText(t('latex.fontsTitle'))).toBeTruthy()
    fireEvent.click(modal.parentElement as HTMLElement)
    expect(screen.queryByText(t('latex.fontsTitle'))).toBeNull()
    openFonts()
    fireEvent.click(button(t('latex.close')))
    expect(screen.queryByText(t('latex.fontsTitle'))).toBeNull()
  })
})
