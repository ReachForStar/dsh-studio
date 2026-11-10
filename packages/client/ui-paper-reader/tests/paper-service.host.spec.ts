/** Host half: the paper library's upload, read, annotate, and delete routes. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { handlePaperRequest } from '../src/paper-service.ts'
import { PAPER_READER_ROUTE } from '../src/route.ts'
import type { PaperAnnotation, PaperRecord, PaperSummary } from '../src/types.ts'

const PDF = Buffer.from('%PDF-1.7\nfixture body\n%%EOF', 'latin1')

interface ResponseDouble {
  readonly res: unknown
  readonly status: number
  readonly body: Buffer
  readonly headers: Record<string, string>
  text(): string
}

function responseDouble(): ResponseDouble {
  let statusCode = 0
  let body: Buffer = Buffer.alloc(0)
  const headers: Record<string, string> = {}
  return {
    res: {
      writeHead(status: number, values?: Record<string, string>) {
        statusCode = status
        if (values !== undefined) Object.assign(headers, values)
      },
      end(payload: string | Buffer) {
        body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
      },
    },
    get status(): number { return statusCode },
    get body(): Buffer { return body },
    get headers(): Record<string, string> { return headers },
    text(): string { return body.toString('utf8') },
  }
}

/** Request double: one body chunk then end, or a stream that only faults. */
function requestDouble(method: string, path: string, body?: Buffer, mode: 'ok' | 'fault' = 'ok') {
  let onError: ((error: Error) => void) | undefined
  return {
    url: path,
    method,
    on(event: 'data' | 'end' | 'error', fn: (chunk?: Buffer) => void) {
      if (mode === 'ok') {
        if (event === 'data' && body !== undefined) fn(body)
        if (event === 'end') fn()
      }
      if (event === 'error') onError = fn as unknown as (error: Error) => void
      return this
    },
    destroy() {},
    emitError(error: Error) {
      onError?.(error)
    },
  }
}

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-paper-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function call(
  method: string,
  path: string,
  body?: Buffer,
  cap = 1024 * 1024,
): Promise<ResponseDouble> {
  const response = responseDouble()
  await handlePaperRequest(
    dir,
    cap,
    requestDouble(method, `${PAPER_READER_ROUTE}${path}`, body) as never,
    response.res as never,
  )
  return response
}

async function upload(name = 'attention.pdf'): Promise<PaperRecord> {
  const response = await call('POST', `/papers?name=${encodeURIComponent(name)}`, PDF)
  expect(response.status).toBe(200)
  return (JSON.parse(response.text()) as { paper: PaperRecord }).paper
}

/** One annotation shaped exactly as the reader writes it. */
function annotation(overrides: Partial<PaperAnnotation> = {}): PaperAnnotation {
  return {
    id: 'annotation-1',
    page: 1,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
    text: 'selected passage',
    createdAt: '2026-11-09T00:00:00.000Z',
    ...overrides,
  }
}

/** The error text of one JSON response double. */
function errorOf(text: string): string | undefined {
  return (JSON.parse(text) as { error?: string }).error
}

describe('paper library routes', () => {
  it('stores a PDF and lists it newest first', async () => {
    const first = await upload('first.pdf')
    const second = await upload('second.pdf')
    expect(first.name).toBe('first.pdf')
    expect(first.size).toBe(PDF.length)
    expect(first.annotationCount).toBe(0)

    const list = await call('GET', '/papers')
    expect(list.status).toBe(200)
    const papers = (JSON.parse(list.text()) as { papers: readonly PaperSummary[] }).papers
    expect(papers.map(paper => paper.id)).toEqual([second.id, first.id])
    expect(papers[0]?.name).toBe('second.pdf')
  })

  it('serves the stored bytes unchanged', async () => {
    const paper = await upload()
    const file = await call('GET', `/papers/${paper.id}/file`)
    expect(file.status).toBe(200)
    expect(file.headers['content-type']).toBe('application/pdf')
    expect(file.body.equals(PDF)).toBe(true)
    expect((await readFile(join(dir, `${paper.id}.pdf`))).equals(PDF)).toBe(true)
  })

  it('reads one paper with its annotations and replaces the list', async () => {
    const paper = await upload()
    const written = await call('PUT', `/papers/${paper.id}/annotations`, Buffer.from(JSON.stringify({
      annotations: [annotation(), annotation({ id: 'annotation-2', note: 'my note' })],
    })))
    expect(written.status).toBe(200)
    const updated = (JSON.parse(written.text()) as { paper: PaperRecord }).paper
    expect(updated.annotations).toHaveLength(2)
    expect(updated.annotations[1]?.note).toBe('my note')

    const read = await call('GET', `/papers/${paper.id}`)
    expect(read.status).toBe(200)
    const record = (JSON.parse(read.text()) as { paper: PaperRecord }).paper
    expect(record.annotationCount).toBe(2)
    expect(record.annotations[0]?.text).toBe('selected passage')
  })

  it('deletes the paper and its annotation document', async () => {
    const paper = await upload()
    const removed = await call('DELETE', `/papers/${paper.id}`)
    expect(removed.status).toBe(200)
    expect(JSON.parse(removed.text())).toEqual({ ok: true })
    expect((await call('GET', `/papers/${paper.id}`)).status).toBe(404)
    expect((await call('GET', `/papers/${paper.id}/file`)).status).toBe(404)
  })

  it('returns an empty library before anything is uploaded', async () => {
    const list = await call('GET', '/papers')
    expect(list.status).toBe(200)
    expect(JSON.parse(list.text())).toEqual({ papers: [] })
  })
})

describe('upload validation', () => {
  it('refuses a body without the PDF signature', async () => {
    const response = await call('POST', '/papers?name=x.pdf', Buffer.from('plain text'))
    expect(response.status).toBe(400)
    expect(errorOf(response.text())).toContain('not a PDF')
  })

  it('refuses a body above the cap', async () => {
    const response = await call('POST', '/papers?name=x.pdf', Buffer.alloc(64, 0x25), 16)
    expect(response.status).toBe(413)
    expect(errorOf(response.text())).toContain('exceeds')
  })

  it('reduces the uploaded name to a safe basename', async () => {
    const unnamed = await call('POST', '/papers', PDF)
    expect((JSON.parse(unnamed.text()) as { paper: PaperRecord }).paper.name).toBe('paper.pdf')
    const traversal = await upload('../../etc/passwd\u0007.pdf')
    expect(traversal.name).toBe('passwd.pdf')
    const blank = await upload('   ')
    expect(blank.name).toBe('paper.pdf')
    const long = await upload(`${'a'.repeat(300)}.pdf`)
    expect(long.name).toHaveLength(200)
  })
})

describe('annotation validation', () => {
  async function write(value: unknown): Promise<ResponseDouble> {
    const paper = await upload()
    return call('PUT', `/papers/${paper.id}/annotations`, Buffer.from(JSON.stringify(value)))
  }

  it('rejects a body that is not an object', async () => {
    const response = await write(null)
    expect(response.status).toBe(400)
    expect(errorOf(response.text())).toContain('body must be an object')
  })

  it('rejects a missing annotation list', async () => {
    const response = await write({ annotations: 'none' })
    expect(response.status).toBe(400)
    expect(errorOf(response.text())).toContain('annotations must be an array')
  })

  it('rejects a list above the cap', async () => {
    const response = await write({ annotations: Array.from({ length: 5001 }, () => annotation()) })
    expect(response.status).toBe(413)
    expect(errorOf(response.text())).toContain('at most 5000')
  })

  it.each([
    ['a non-object entry', null, 'must be an object'],
    ['a missing id', { ...annotation(), id: undefined }, 'id is required'],
    ['an empty id', annotation({ id: '' }), 'id is required'],
    ['a non-numeric page', { ...annotation(), page: '1' }, 'page must be a positive integer'],
    ['a fractional page', annotation({ page: 1.5 }), 'page must be a positive integer'],
    ['a zero page', annotation({ page: 0 }), 'page must be a positive integer'],
    ['a non-array rects field', { ...annotation(), rects: 'none' }, 'rects must be normalized rectangles'],
    ['an empty rects field', annotation({ rects: [] }), 'rects must be normalized rectangles'],
    ['a rect outside the page', annotation({ rects: [{ x: 1.5, y: 0, width: 0, height: 0 }] }), 'rects must be normalized rectangles'],
    ['a non-object rect', annotation({ rects: [1 as never] }), 'rects must be normalized rectangles'],
    ['a negative rect', annotation({ rects: [{ x: -1, y: 0, width: 0, height: 0 }] }), 'rects must be normalized rectangles'],
    ['a non-finite rect', annotation({ rects: [{ x: Number.NaN, y: 0, width: 0, height: 0 }] }), 'rects must be normalized rectangles'],
    ['a non-string text', { ...annotation(), text: 7 }, 'text must be a string'],
    ['a non-string note', { ...annotation(), note: 7 }, 'note must be a string'],
    ['a non-string createdAt', { ...annotation(), createdAt: 7 }, 'createdAt must be a string'],
  ])('rejects %s', async (_label, value, message) => {
    const response = await write({ annotations: [value] })
    expect(response.status).toBe(400)
    expect(errorOf(response.text())).toContain(message)
  })

  it('keeps an absent note absent', async () => {
    const paper = await upload()
    const response = await call('PUT', `/papers/${paper.id}/annotations`,
      Buffer.from(JSON.stringify({ annotations: [annotation()] })))
    const record = (JSON.parse(response.text()) as { paper: PaperRecord }).paper
    expect(Object.hasOwn(record.annotations[0] as object, 'note')).toBe(false)
  })
})

describe('library faults', () => {
  it('answers 404 for an unknown paper and an unknown route', async () => {
    expect((await call('GET', `/papers/${randomUUID()}`)).status).toBe(404)
    expect((await call('GET', '/papers/not-an-id')).status).toBe(404)
    expect((await call('GET', '/nope')).status).toBe(404)
    expect((await call('PATCH', '/papers')).status).toBe(404)
  })

  it('answers 404 for an unknown method on a known paper', async () => {
    const paper = await upload()
    const response = await call('PATCH', `/papers/${paper.id}`)
    expect(response.status).toBe(404)
    expect(errorOf(response.text())).toContain('unknown route')
  })

  it('answers 500 for an unreadable document and keeps the rest of the library', async () => {
    const broken = randomUUID()
    await writeFile(join(dir, `${broken}.json`), 'not json')
    const healthy = await upload('healthy.pdf')
    const list = await call('GET', '/papers')
    expect(list.status).toBe(200)
    const papers = (JSON.parse(list.text()) as { papers: readonly PaperSummary[] }).papers
    expect(papers.map(paper => paper.id)).toEqual([healthy.id])
    expect((await call('GET', `/papers/${broken}`)).status).toBe(500)
  })

  it('answers 500 for a document that is not an object', async () => {
    const id = randomUUID()
    await writeFile(join(dir, `${id}.json`), 'null')
    expect((await call('GET', `/papers/${id}`)).status).toBe(500)
  })

  it('falls back to default fields in a partial document', async () => {
    const id = randomUUID()
    await writeFile(join(dir, `${id}.json`), '{}')
    await writeFile(join(dir, `${id}.pdf`), PDF)
    const response = await call('GET', `/papers/${id}`)
    expect(response.status).toBe(200)
    const record = (JSON.parse(response.text()) as { paper: PaperRecord }).paper
    expect(record.name).toBe('paper.pdf')
    expect(record.size).toBe(0)
    expect(record.annotations).toEqual([])
  })

  it('ignores unrelated files in the library directory', async () => {
    await writeFile(join(dir, 'notes.txt'), 'ignored')
    expect(JSON.parse((await call('GET', '/papers')).text())).toEqual({ papers: [] })
  })

  it('answers 500 when the request body stream fails', async () => {
    const response = responseDouble()
    const req = requestDouble('POST', `${PAPER_READER_ROUTE}/papers?name=x.pdf`, undefined, 'fault')
    const pending = handlePaperRequest(dir, 1024, req as never, response.res as never)
    req.emitError(new Error('socket hang up'))
    await pending
    expect(response.status).toBe(500)
    expect(errorOf(response.text())).toContain('socket hang up')
  })

  it('treats a missing request URL and method as an unknown route', async () => {
    const response = responseDouble()
    await handlePaperRequest(dir, 1024, { on() { return this } } as never, response.res as never)
    expect(response.status).toBe(404)
  })

  it('answers an empty library when the directory does not exist', async () => {
    const missing = join(dir, 'never-created')
    const response = responseDouble()
    await handlePaperRequest(missing, 1024, requestDouble('GET', `${PAPER_READER_ROUTE}/papers`) as never,
      response.res as never)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text())).toEqual({ papers: [] })
  })
})
