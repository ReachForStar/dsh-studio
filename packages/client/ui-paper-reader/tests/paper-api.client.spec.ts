/** Browser client of the paper library: one document-relative request per operation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deletePaper, listPapers, readPaper, readPaperBytes, uploadPaper, writeAnnotations,
} from '../src/client/paper-api.ts'
import { PAPER_READER_CLIENT_ROUTE } from '../src/route.ts'
import type { PaperAnnotation, PaperRecord } from '../src/types.ts'

const RECORD: PaperRecord = {
  id: 'paper-1', name: 'attention.pdf', size: 10, addedAt: '2026-11-09T00:00:00.000Z',
  annotationCount: 0, annotations: [],
}

const ANNOTATION: PaperAnnotation = {
  id: 'a1', page: 1, rects: [{ x: 0, y: 0, width: 1, height: 1 }], text: 'text',
  createdAt: '2026-11-09T00:00:00.000Z',
}

/** Stub fetch with one JSON response and record every request. */
function jsonFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve('detail'),
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    })
  })
  vi.stubGlobal('fetch', fetch)
  return calls
}

const signal = new AbortController().signal

afterEach(() => { vi.unstubAllGlobals() })

describe('paper library client', () => {
  it('lists stored papers through the document-relative prefix', async () => {
    const calls = jsonFetch({ papers: [RECORD] })
    expect(await listPapers(signal)).toEqual([RECORD])
    expect(calls[0]?.url).toBe(`${PAPER_READER_CLIENT_ROUTE}/papers`)
    expect(calls[0]?.init?.signal).toBe(signal)
  })

  it('uploads a file with its encoded name', async () => {
    const calls = jsonFetch({ paper: RECORD })
    const file = new File(['%PDF-'], 'my paper.pdf', { type: 'application/pdf' })
    expect(await uploadPaper(file, signal)).toEqual(RECORD)
    expect(calls[0]?.url).toBe(`${PAPER_READER_CLIENT_ROUTE}/papers?name=my%20paper.pdf`)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toBe(file)
  })

  it('reads one paper and its bytes', async () => {
    const calls = jsonFetch({ paper: RECORD })
    expect(await readPaper('paper-1', signal)).toEqual(RECORD)
    expect(calls[0]?.url).toBe(`${PAPER_READER_CLIENT_ROUTE}/papers/paper-1`)

    jsonFetch(undefined)
    expect([...(await readPaperBytes('paper-1', signal))]).toEqual([1, 2, 3])
  })

  it('writes the whole annotation list', async () => {
    const calls = jsonFetch({ paper: RECORD })
    expect(await writeAnnotations('paper-1', [ANNOTATION], signal)).toEqual(RECORD)
    expect(calls[0]?.url).toBe(`${PAPER_READER_CLIENT_ROUTE}/papers/paper-1/annotations`)
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ annotations: [ANNOTATION] })
  })

  it('deletes one paper', async () => {
    const calls = jsonFetch({ ok: true })
    await deletePaper('paper-1', signal)
    expect(calls[0]?.url).toBe(`${PAPER_READER_CLIENT_ROUTE}/papers/paper-1`)
    expect(calls[0]?.init?.method).toBe('DELETE')
  })

  it('reports the server status and detail on a failed request', async () => {
    jsonFetch({}, 404)
    await expect(readPaper('missing', signal)).rejects.toThrow('paper-reader: 404 detail')
  })

  it('still reports the status when the failure body cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('body gone')),
    })))
    await expect(listPapers(signal)).rejects.toThrow('paper-reader: 500')
  })

  it('reports a failed byte read with the paper identity', async () => {
    jsonFetch({}, 404)
    await expect(readPaperBytes('missing', signal)).rejects.toThrow('404 reading paper missing')
  })
})
