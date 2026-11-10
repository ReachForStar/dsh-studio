// @vitest-environment jsdom
/** The paper page: library operations, one open paper, and the composer question. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaperAnnotation, PaperRecord, PaperSummary } from '../src/types.ts'

const api = vi.hoisted(() => ({
  listPapers: vi.fn(),
  uploadPaper: vi.fn(),
  readPaper: vi.fn(),
  readPaperBytes: vi.fn(),
  deletePaper: vi.fn(),
  writeAnnotations: vi.fn(),
}))
vi.mock('../src/client/paper-api.ts', () => api)

interface ViewerProps {
  readonly annotations: readonly PaperAnnotation[]
  readonly ask: (text: string) => boolean
  readonly onCreate: (annotation: PaperAnnotation) => void
  readonly onRemove: (id: string) => void
  readonly translateTarget: 'zh' | 'en'
}
vi.mock('../src/client/PdfViewer.tsx', () => ({
  PdfViewer: (props: ViewerProps) => (
    <div data-testid="viewer">
      <span data-testid="annotation-count">{String(props.annotations.length)}</span>
      <span data-testid="translate-target">{props.translateTarget}</span>
      <button type="button" onClick={() => { props.onCreate(NEW_ANNOTATION) }}>create</button>
      <button type="button" onClick={() => { props.onRemove(props.annotations[0]?.id ?? 'none') }}>remove</button>
      <button type="button" onClick={() => { props.ask('selected passage') }}>ask</button>
    </div>
  ),
}))
import { PaperReaderTab } from '../src/client/PaperReader.tsx'
import type { PaperReaderTabProps } from '../src/client/PaperReader.tsx'

const NEW_ANNOTATION: PaperAnnotation = {
  id: 'new', page: 1, rects: [{ x: 0, y: 0, width: 1, height: 1 }], text: 'selected',
  createdAt: '2026-11-09T00:00:00.000Z',
}

const SUMMARY: PaperSummary = {
  id: 'paper-1', name: 'attention.pdf', size: 2048, addedAt: '2026-11-09T00:00:00.000Z', annotationCount: 2,
}
const RECORD: PaperRecord = { ...SUMMARY, annotations: [NEW_ANNOTATION] }

/** Localized keys echo their parameters so assertions can name both. */
const t = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`

const inputActions = {
  captureInsertion: vi.fn(() => ({ from: 0, to: 0 })),
  insertText: vi.fn(() => true),
  insertQuote: vi.fn(() => true),
}

function renderTab(language = 'en') {
  const props = {
    t,
    inputActions,
    useLanguage: (selector: (snapshot: { active: string; locales: []; revision: number }) => unknown) =>
      selector({ active: language, locales: [], revision: 0 }),
  } as unknown as PaperReaderTabProps
  return render(<PaperReaderTab {...props} />)
}

/** Wait for the library list to finish its first load. */
async function libraryReady(): Promise<void> {
  await waitFor(() => { expect(api.listPapers).toHaveBeenCalled() })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  vi.clearAllMocks()
  inputActions.captureInsertion.mockReturnValue({ from: 0, to: 0 })
  inputActions.insertText.mockReturnValue(true)
  inputActions.insertQuote.mockReturnValue(true)
})
afterEach(cleanup)

describe('paper library', () => {
  it('lists stored papers with size and annotation count, then opens one', async () => {
    api.listPapers.mockResolvedValue([SUMMARY])
    api.readPaper.mockResolvedValue(RECORD)
    api.readPaperBytes.mockResolvedValue(new Uint8Array([1]))
    renderTab()
    expect(screen.getByRole('status').textContent).toBe('loading')
    await libraryReady()
    expect(screen.getByText('attention.pdf')).toBeDefined()
    expect(screen.getByText(/2 KB/)).toBeDefined()
    expect(screen.getByText(/annotationCount:\{"count":2\}/)).toBeDefined()

    fireEvent.click(screen.getByLabelText('openPaper:{"name":"attention.pdf"}'))
    await waitFor(() => { expect(screen.getByTestId('viewer')).toBeDefined() })
    expect(api.readPaper).toHaveBeenCalledWith('paper-1', expect.any(AbortSignal))
    expect(screen.getByText('attention.pdf')).toBeDefined()
  })

  it('shows an empty library', async () => {
    api.listPapers.mockResolvedValue([])
    renderTab()
    await libraryReady()
    expect(screen.getByText('emptyLibrary')).toBeDefined()
  })

  it('reports a list failure and retries', async () => {
    api.listPapers.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([SUMMARY])
    renderTab()
    await waitFor(() => { expect(screen.getByText('listFailed')).toBeDefined() })
    fireEvent.click(screen.getByText('retry'))
    await waitFor(() => { expect(screen.getByText('attention.pdf')).toBeDefined() })
    expect(api.listPapers).toHaveBeenCalledTimes(2)
  })

  it('uploads the chosen file and prepends it', async () => {
    api.listPapers.mockResolvedValue([])
    const uploaded = { ...SUMMARY, id: 'paper-2', name: 'new.pdf', annotationCount: 0, annotations: [] }
    const upload = Promise.withResolvers<PaperRecord>()
    api.uploadPaper.mockReturnValue(upload.promise)
    const { container } = renderTab()
    await libraryReady()

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['%PDF-'], 'new.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(screen.getByText('uploading')).toBeDefined()
    await act(async () => { upload.resolve(uploaded) })
    expect(api.uploadPaper).toHaveBeenCalledWith(file, expect.any(AbortSignal))
    expect(screen.getByText('new.pdf')).toBeDefined()
  })

  it('ignores a change with no chosen file', async () => {
    api.listPapers.mockResolvedValue([])
    const { container } = renderTab()
    await libraryReady()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [] } })
    expect(api.uploadPaper).not.toHaveBeenCalled()
  })

  it('reports an upload failure', async () => {
    api.listPapers.mockResolvedValue([])
    api.uploadPaper.mockRejectedValue(new Error('too large'))
    const { container } = renderTab()
    await libraryReady()
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement,
      { target: { files: [new File(['x'], 'x.pdf')] } })
    await waitFor(() => { expect(screen.getByText('uploadFailed')).toBeDefined() })
  })

  it('deletes a paper and reports a failure', async () => {
    api.listPapers.mockResolvedValue([SUMMARY])
    const removal = Promise.withResolvers<undefined>()
    api.deletePaper.mockReturnValue(removal.promise)
    renderTab()
    await libraryReady()
    fireEvent.click(screen.getByLabelText('deletePaper'))
    expect(api.deletePaper).toHaveBeenCalledWith('paper-1', expect.any(AbortSignal))
    await act(async () => { removal.resolve(undefined) })
    expect(screen.queryByText('attention.pdf')).toBeNull()

    api.listPapers.mockResolvedValue([SUMMARY])
    fireEvent.click(screen.getByLabelText('refresh'))
    await libraryReady()
    api.deletePaper.mockRejectedValueOnce(new Error('busy'))
    fireEvent.click(screen.getByLabelText('deletePaper'))
    await waitFor(() => { expect(screen.getByText('deleteFailed')).toBeDefined() })
  })

  it('ignores a list that arrives after the page closed', async () => {
    const listed = Promise.withResolvers<readonly PaperSummary[]>()
    api.listPapers.mockReturnValue(listed.promise)
    const { unmount } = renderTab()
    unmount()
    listed.resolve([SUMMARY])
    await act(async () => { await Promise.resolve() })
  })

  it('ignores a list failure after the page closed', async () => {
    const listed = Promise.withResolvers<readonly PaperSummary[]>()
    api.listPapers.mockReturnValue(listed.promise)
    const { unmount } = renderTab()
    unmount()
    listed.reject(new Error('late'))
    await act(async () => { await Promise.resolve() })
  })

  it('keeps an upload that finishes before the library has loaded', async () => {
    const listed = Promise.withResolvers<readonly PaperSummary[]>()
    api.listPapers.mockReturnValue(listed.promise)
    api.uploadPaper.mockResolvedValue({ ...SUMMARY, id: 'paper-2', name: 'new.pdf' })
    const { container } = renderTab()
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement,
      { target: { files: [new File(['x'], 'new.pdf')] } })
    await act(async () => { await Promise.resolve() })
    expect(api.uploadPaper).toHaveBeenCalledOnce()
    expect(screen.getByText('loading')).toBeDefined()
    await act(async () => { listed.resolve([]) })
    expect(screen.getByText('emptyLibrary')).toBeDefined()
  })

  it('opens the file picker from the upload action', async () => {
    api.listPapers.mockResolvedValue([])
    const { container } = renderTab()
    await libraryReady()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByText('upload'))
    expect(click).toHaveBeenCalledOnce()
  })
})

describe('open paper', () => {
  async function openPaper(): Promise<void> {
    api.listPapers.mockResolvedValue([SUMMARY])
    api.readPaper.mockResolvedValue(RECORD)
    api.readPaperBytes.mockResolvedValue(new Uint8Array([1]))
    renderTab()
    await libraryReady()
    fireEvent.click(screen.getByLabelText('openPaper:{"name":"attention.pdf"}'))
    await waitFor(() => { expect(screen.getByTestId('viewer')).toBeDefined() })
  }

  it('starts from the stored annotations and returns to the library', async () => {
    await openPaper()
    expect(screen.getByTestId('annotation-count').textContent).toBe('1')
    fireEvent.click(screen.getByText('back'))
    await waitFor(() => { expect(screen.queryByTestId('viewer')).toBeNull() })
  })

  it('starts translations in Chinese for a Chinese interface and English otherwise', async () => {
    api.listPapers.mockResolvedValue([SUMMARY])
    api.readPaper.mockResolvedValue(RECORD)
    api.readPaperBytes.mockResolvedValue(new Uint8Array([1]))
    const chinese = renderTab('zh')
    await waitFor(() => { expect(screen.getByText('attention.pdf')).toBeDefined() })
    fireEvent.click(screen.getByLabelText('openPaper:{"name":"attention.pdf"}'))
    await waitFor(() => { expect(screen.getByTestId('translate-target').textContent).toBe('zh') })
    chinese.unmount()

    renderTab('ja')
    await waitFor(() => { expect(screen.getByText('attention.pdf')).toBeDefined() })
    fireEvent.click(screen.getByLabelText('openPaper:{"name":"attention.pdf"}'))
    await waitFor(() => { expect(screen.getByTestId('translate-target').textContent).toBe('en') })
  })

  it('appends a new annotation and persists the whole list', async () => {
    api.writeAnnotations.mockResolvedValue(RECORD)
    await openPaper()
    fireEvent.click(screen.getByText('create'))
    expect(screen.getByTestId('annotation-count').textContent).toBe('2')
    expect(api.writeAnnotations).toHaveBeenCalledWith('paper-1',
      [RECORD.annotations[0], NEW_ANNOTATION], expect.any(AbortSignal))
  })

  it('removes an annotation and persists the whole list', async () => {
    api.writeAnnotations.mockResolvedValue(RECORD)
    await openPaper()
    fireEvent.click(screen.getByText('remove'))
    expect(screen.getByTestId('annotation-count').textContent).toBe('0')
    expect(api.writeAnnotations).toHaveBeenCalledWith('paper-1', [], expect.any(AbortSignal))
  })

  it('reports a failed annotation write', async () => {
    api.writeAnnotations.mockRejectedValue(new Error('read only'))
    await openPaper()
    fireEvent.click(screen.getByText('create'))
    await waitFor(() => { expect(screen.getByText('annotationFailed')).toBeDefined() })
  })

  it('reports a paper that cannot be read', async () => {
    api.listPapers.mockResolvedValue([SUMMARY])
    api.readPaper.mockRejectedValue(new Error('gone'))
    renderTab()
    await libraryReady()
    fireEvent.click(screen.getByLabelText('openPaper:{"name":"attention.pdf"}'))
    await waitFor(() => { expect(screen.getByText('loadFailed')).toBeDefined() })
  })

  it('fills the composer draft with the question template and the selection', async () => {
    await openPaper()
    fireEvent.click(screen.getByText('ask'))
    expect(inputActions.captureInsertion).toHaveBeenCalledOnce()
    expect(inputActions.insertText).toHaveBeenCalledWith('askPrompt\n\n', { from: 0, to: 0 })
    expect(inputActions.insertQuote).toHaveBeenCalledWith('selected passage')
  })

  it('declines when the composer refuses the draft', async () => {
    inputActions.insertText.mockReturnValue(false)
    await openPaper()
    fireEvent.click(screen.getByText('ask'))
    expect(inputActions.insertQuote).not.toHaveBeenCalled()
  })

  it('ignores a paper that loads after the page closed', async () => {
    api.listPapers.mockResolvedValue([SUMMARY])
    const record = Promise.withResolvers<PaperRecord>()
    const bytes = Promise.withResolvers<Uint8Array<ArrayBuffer>>()
    api.readPaper.mockReturnValue(record.promise)
    api.readPaperBytes.mockReturnValue(bytes.promise)
    const { unmount } = renderTab()
    await libraryReady()
    fireEvent.click(screen.getByLabelText('openPaper:{"name":"attention.pdf"}'))
    await waitFor(() => { expect(api.readPaper).toHaveBeenCalled() })
    unmount()
    record.resolve(RECORD)
    bytes.resolve(new Uint8Array([1]))
    await act(async () => { await Promise.resolve() })
  })

  it('ignores a paper load failure after the page closed', async () => {
    api.listPapers.mockResolvedValue([SUMMARY])
    const record = Promise.withResolvers<PaperRecord>()
    api.readPaper.mockReturnValue(record.promise)
    const { unmount } = renderTab()
    await libraryReady()
    fireEvent.click(screen.getByLabelText('openPaper:{"name":"attention.pdf"}'))
    await waitFor(() => { expect(api.readPaper).toHaveBeenCalled() })
    unmount()
    record.reject(new Error('late'))
    await act(async () => { await Promise.resolve() })
  })

  it('ignores an annotation write failure after the page closed', async () => {
    api.listPapers.mockResolvedValue([SUMMARY])
    api.readPaper.mockResolvedValue(RECORD)
    api.readPaperBytes.mockResolvedValue(new Uint8Array([1]))
    const write = Promise.withResolvers<PaperRecord>()
    api.writeAnnotations.mockReturnValue(write.promise)
    const { unmount } = renderTab()
    await libraryReady()
    fireEvent.click(screen.getByLabelText('openPaper:{"name":"attention.pdf"}'))
    await waitFor(() => { expect(screen.getByTestId('viewer')).toBeDefined() })
    fireEvent.click(screen.getByText('create'))
    unmount()
    write.reject(new Error('late'))
    await act(async () => { await Promise.resolve() })
  })
})

describe('formatSize', () => {
  it('renders bytes, kilobytes, and megabytes', async () => {
    api.listPapers.mockResolvedValue([
      { ...SUMMARY, id: 'a', name: 'a.pdf', size: 500, annotationCount: 0 },
      { ...SUMMARY, id: 'b', name: 'b.pdf', size: 2048, annotationCount: 0 },
      { ...SUMMARY, id: 'c', name: 'c.pdf', size: 2 * 1024 * 1024, annotationCount: 0 },
    ])
    renderTab()
    await libraryReady()
    expect(screen.getByText(/500 B/)).toBeDefined()
    expect(screen.getByText(/2 KB/)).toBeDefined()
    expect(screen.getByText(/2\.0 MB/)).toBeDefined()
  })
})
