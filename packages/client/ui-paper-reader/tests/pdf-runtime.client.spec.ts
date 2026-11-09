// @vitest-environment jsdom
/** One real module Worker and PDF.js loading task per opened paper. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PdfDocument, PdfSession } from '../src/client/pdf/runtime.ts'

const api = vi.hoisted(() => ({ getDocument: vi.fn(), createWorker: vi.fn(), destroyBridge: vi.fn() }))
vi.mock('pdfjs-dist', () => ({ getDocument: api.getDocument, PDFWorker: { create: api.createWorker } }))
vi.mock('../src/client/pdf/assets.ts', () => ({
  workerSource: 'export const WorkerMessageHandler = {}',
  createPdfBinaryDataFactory: () => class { fetch() { return Promise.resolve(new Uint8Array()) } },
}))
import { openPdf } from '../src/client/pdf/runtime.ts'

const NativeURL = URL
const workers: ControlledWorker[] = []
const sessions: PdfSession[] = []
const createURL = vi.fn(() => 'blob:paper-worker')
const revokeURL = vi.fn()

class ControlledWorker extends EventTarget {
  readonly terminate = vi.fn()
  constructor(readonly url: string, readonly options: WorkerOptions) {
    super()
    workers.push(this)
  }
  ready(): void { this.dispatchEvent(new MessageEvent('message', { data: { type: 'dsh-paper-pdf-worker-ready' } })) }
}

beforeEach(() => {
  workers.length = 0
  sessions.length = 0
  vi.clearAllMocks()
  api.createWorker.mockReturnValue({ destroy: api.destroyBridge })
  vi.stubGlobal('Worker', ControlledWorker)
  vi.stubGlobal('URL', class extends NativeURL {
    static override createObjectURL = createURL
    static override revokeObjectURL = revokeURL
  })
})

afterEach(async () => {
  try {
    await Promise.allSettled(sessions.map(session => session.dispose()))
  } finally {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
})

function setup(controller = new AbortController(), failed = vi.fn()) {
  const loading = Promise.withResolvers<PdfDocument>()
  const entered = Promise.withResolvers<unknown>()
  const destroy = vi.fn(async () => {})
  api.getDocument.mockImplementation((options: unknown) => {
    entered.resolve(options)
    return { promise: loading.promise, destroy }
  })
  const data = new TextEncoder().encode('%PDF-test')
  const session = openPdf(data, controller.signal, failed)
  sessions.push(session)
  void session.document.catch(() => {})
  return {
    loading, entered, destroy, controller, failed, session, data,
    workersReady: () => { workers[0]?.ready() },
  }
}

describe('paper PDF worker lifecycle', () => {
  it('starts a module worker, hands PDF.js complete bytes, and releases everything once', async () => {
    const h = setup()
    expect(workers[0]?.options).toEqual({ type: 'module', name: 'dsh-paper-pdf' })
    expect(api.getDocument).not.toHaveBeenCalled()
    h.workersReady()
    const options = await h.entered.promise as { data: Uint8Array<ArrayBuffer>; BinaryDataFactory: unknown }
    expect(api.createWorker).toHaveBeenCalledWith({ port: workers[0] })
    expect(options).toMatchObject({ cMapPacked: true, useWorkerFetch: false, enableXfa: false, stopAtErrors: true })
    expect(typeof options.BinaryDataFactory).toBe('function')
    expect(Array.from(options.data)).toEqual([37, 80, 68, 70, 45, 116, 101, 115, 116])
    expect(options.data).not.toBe(h.data)

    const document = { numPages: 2, getPage: vi.fn() }
    h.loading.resolve(document)
    await expect(h.session.document).resolves.toBe(document)
    await h.session.dispose()
    await h.session.dispose()
    expect(h.destroy).toHaveBeenCalledOnce()
    expect(api.destroyBridge).toHaveBeenCalledOnce()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith('blob:paper-worker')
  })

  it('allocates no worker for an already-ended lifetime', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = setup(controller)
    await expect(h.session.document).rejects.toMatchObject({ name: 'AbortError' })
    await h.session.dispose()
    expect(workers).toEqual([])
    expect(createURL).not.toHaveBeenCalled()
    expect(api.getDocument).not.toHaveBeenCalled()
  })

  it('cancels startup before the handshake without invoking PDF.js', async () => {
    const h = setup()
    h.controller.abort()
    await expect(h.session.document).rejects.toMatchObject({ name: 'AbortError' })
    await h.session.dispose()
    workers[0]?.ready()
    expect(api.getDocument).not.toHaveBeenCalled()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    expect(revokeURL).toHaveBeenCalledOnce()
  })

  it('awaits document destruction before terminating a healthy worker', async () => {
    const h = setup()
    h.workersReady()
    await h.entered.promise
    const destruction = Promise.withResolvers<undefined>()
    const destroying = Promise.withResolvers<undefined>()
    h.destroy.mockImplementation(async () => { destroying.resolve(undefined); await destruction.promise })
    h.controller.abort()
    await destroying.promise
    expect(workers[0]?.terminate).not.toHaveBeenCalled()
    h.loading.resolve({ numPages: 99, getPage: vi.fn() })
    destruction.resolve(undefined)
    await expect(h.session.document).rejects.toMatchObject({ name: 'AbortError' })
    await h.session.dispose()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
  })

  it('reports a worker startup failure without a main-thread fallback', async () => {
    const h = setup()
    const error = new ErrorEvent('error', { message: 'worker blocked' })
    workers[0]?.dispatchEvent(error)
    await expect(h.session.document).rejects.toMatchObject({ message: 'paper: PDF worker failed' })
    expect(h.failed).toHaveBeenCalledOnce()
    expect(h.failed.mock.calls[0]?.[0]).toMatchObject({ cause: error })
    expect(api.getDocument).not.toHaveBeenCalled()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    expect(revokeURL).toHaveBeenCalledOnce()
  })

  it('reports a worker crash after loading and releases the document', async () => {
    const h = setup()
    h.workersReady()
    await h.entered.promise
    h.loading.resolve({ numPages: 1, getPage: vi.fn() })
    await h.session.document
    workers[0]?.dispatchEvent(new MessageEvent('messageerror'))
    await h.session.dispose()
    expect(h.failed).toHaveBeenCalledOnce()
    expect(h.destroy).toHaveBeenCalledOnce()
    expect(api.destroyBridge).toHaveBeenCalledOnce()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
  })

  it('ignores unrelated Worker messages until its own acknowledgement', async () => {
    const h = setup()
    for (const data of [null, 'noise', { action: 'ready' }, { type: 'other-worker' }]) {
      workers[0]?.dispatchEvent(new MessageEvent('message', { data }))
    }
    expect(api.getDocument).not.toHaveBeenCalled()
    h.workersReady()
    await h.entered.promise
    h.loading.resolve({ numPages: 1, getPage: vi.fn() })
    await expect(h.session.document).resolves.toBeDefined()
  })

  it('suppresses a late failure report and finishes cleanup when the worker crashes after abort', async () => {
    const h = setup()
    h.workersReady()
    await h.entered.promise
    h.loading.resolve({ numPages: 1, getPage: vi.fn() })
    await h.session.document
    const destruction = Promise.withResolvers<undefined>()
    const destroying = Promise.withResolvers<undefined>()
    h.destroy.mockImplementation(async () => { destroying.resolve(undefined); await destruction.promise })
    h.controller.abort()
    await destroying.promise
    workers[0]?.dispatchEvent(new MessageEvent('messageerror'))
    await h.session.dispose()
    expect(h.failed).not.toHaveBeenCalled()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    destruction.resolve(undefined)
  })

  it('logs a teardown rejection after releasing the bridge, worker, and blob', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = setup()
    h.workersReady()
    await h.entered.promise
    h.loading.resolve({ numPages: 1, getPage: vi.fn() })
    await h.session.document
    const failure = new Error('terminate RPC rejected')
    h.destroy.mockRejectedValueOnce(failure)
    await expect(h.session.dispose()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledExactlyOnceWith('[paper-reader] PDF cleanup failed', failure)
    expect(api.destroyBridge).toHaveBeenCalledOnce()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
  })
})
