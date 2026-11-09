/**
 * Host half of the paper library: one HTTP surface over a directory of uploaded
 * PDFs and their annotation documents.
 *
 * Routes, all under {@link PAPER_READER_ROUTE}:
 * - `GET    /papers`                 list every stored paper
 * - `POST   /papers?name=<filename>` store the raw PDF request body
 * - `GET    /papers/<id>`            one paper with its annotations
 * - `GET    /papers/<id>/file`       the stored PDF bytes
 * - `PUT    /papers/<id>/annotations` replace the annotation list
 * - `DELETE /papers/<id>`            remove the paper and its annotations
 *
 * A paper is `<id>.pdf` beside `<id>.json`; the JSON document carries the
 * display name and the annotations. Nothing here interprets PDF content, so the
 * bytes are stored and served unchanged.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { PAPER_READER_ROUTE } from './route.ts'
import type {
  PaperAnnotation, PaperAnnotationsUpdate, PaperDocument, PaperRecord, PaperRect, PaperSummary,
} from './types.ts'

/** Identity of a stored paper; also the only path component accepted from a request. */
const PAPER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Longest display name kept from an upload; the PDF itself keeps its full name. */
const MAX_NAME_LENGTH = 200

/** Most annotations one paper may hold; the reader rejects a write above this. */
const MAX_ANNOTATIONS = 5000

/** A request the surface answers with a specific status instead of a server fault. */
class PaperRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Read a request body up to a byte cap.
 * @param req - incoming request.
 * @param cap - largest accepted body.
 * @returns the complete body.
 * @throws {PaperRequestError} when the body exceeds the cap.
 */
function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > cap) {
        reject(new PaperRequestError(413, `paper: upload exceeds ${String(cap)} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

/** @param res - server response. @param status - HTTP status. @param body - JSON body. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Reduce an upload's query name to a display name safe to echo back.
 * @param raw - the `name` query parameter, when present.
 * @returns a trimmed basename with control characters removed.
 */
function displayName(raw: string | null): string {
  const cleaned = basename(raw ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  if (cleaned === '') return 'paper.pdf'
  return cleaned.slice(0, MAX_NAME_LENGTH)
}

/** @param bytes - request body. @returns whether the bytes carry the PDF signature. */
function isPdf(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-'
}

/** @param value - candidate rectangle. @returns whether it is normalized to a page box. */
function isRect(value: unknown): value is PaperRect {
  if (typeof value !== 'object' || value === null) return false
  const rect = value as Record<string, unknown>
  const unit = (entry: unknown): entry is number => typeof entry === 'number' && Number.isFinite(entry)
    && entry >= 0 && entry <= 1
  return unit(rect.x) && unit(rect.y) && unit(rect.width) && unit(rect.height)
}

/**
 * Validate one annotation as the reader writes it.
 * @param value - decoded JSON value.
 * @returns the annotation, with only the fields the store keeps.
 * @throws {PaperRequestError} when a field is missing or out of range.
 */
function parseAnnotation(value: unknown): PaperAnnotation {
  if (typeof value !== 'object' || value === null) throw new PaperRequestError(400, 'paper: annotation must be an object')
  const entry = value as Record<string, unknown>
  const { id, page, rects, text, note, createdAt } = entry
  if (typeof id !== 'string' || id === '') throw new PaperRequestError(400, 'paper: annotation id is required')
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
    throw new PaperRequestError(400, 'paper: annotation page must be a positive integer')
  }
  if (!Array.isArray(rects) || rects.length === 0 || !rects.every(isRect)) {
    throw new PaperRequestError(400, 'paper: annotation rects must be normalized rectangles')
  }
  if (typeof text !== 'string') throw new PaperRequestError(400, 'paper: annotation text must be a string')
  if (note !== undefined && typeof note !== 'string') throw new PaperRequestError(400, 'paper: annotation note must be a string')
  if (typeof createdAt !== 'string') throw new PaperRequestError(400, 'paper: annotation createdAt must be a string')
  return { id, page, rects, text, createdAt, ...note === undefined ? {} : { note } }
}

/**
 * Validate a whole annotation list from a reader.
 * @param value - decoded request body.
 * @returns the annotation list to persist.
 * @throws {PaperRequestError} when the list is malformed or too long.
 */
function parseAnnotations(value: unknown): readonly PaperAnnotation[] {
  if (typeof value !== 'object' || value === null) throw new PaperRequestError(400, 'paper: body must be an object')
  const { annotations } = value as Partial<PaperAnnotationsUpdate>
  if (!Array.isArray(annotations)) throw new PaperRequestError(400, 'paper: annotations must be an array')
  if (annotations.length > MAX_ANNOTATIONS) {
    throw new PaperRequestError(413, `paper: at most ${String(MAX_ANNOTATIONS)} annotations are accepted`)
  }
  return annotations.map(parseAnnotation)
}

/**
 * Read one stored annotation document.
 * @param root - library directory.
 * @param id - paper identity.
 * @returns the document.
 * @throws {PaperRequestError} with 404 when the paper is unknown.
 */
async function readDocument(root: string, id: string): Promise<PaperDocument> {
  let source: string
  try {
    source = await readFile(join(root, `${id}.json`), 'utf8')
  } catch {
    throw new PaperRequestError(404, 'paper: unknown paper')
  }
  const value: unknown = JSON.parse(source)
  if (typeof value !== 'object' || value === null) throw new Error(`paper: ${id}.json is not an object`)
  const document = value as Record<string, unknown>
  const annotations = Array.isArray(document.annotations) ? document.annotations.map(parseAnnotation) : []
  return {
    name: typeof document.name === 'string' ? document.name : 'paper.pdf',
    size: typeof document.size === 'number' ? document.size : 0,
    addedAt: typeof document.addedAt === 'string' ? document.addedAt : new Date(0).toISOString(),
    annotations,
  }
}

/**
 * Project a stored document as the library lists it.
 * @param id - paper identity.
 * @param document - stored document.
 * @returns the summary row.
 */
function summarize(id: string, document: PaperDocument): PaperSummary {
  return {
    id,
    name: document.name,
    size: document.size,
    addedAt: document.addedAt,
    annotationCount: document.annotations.length,
  }
}

/** @param document - stored document. @param id - paper identity. @returns the full record. */
function recordOf(id: string, document: PaperDocument): PaperRecord {
  return { ...summarize(id, document), annotations: document.annotations }
}

/**
 * List every readable paper in the library directory.
 * @param root - library directory.
 * @returns summaries ordered by upload time, newest first.
 */
async function listPapers(root: string): Promise<readonly PaperSummary[]> {
  let names: readonly string[]
  try {
    names = await readdir(root)
  } catch {
    // A library nobody has written to yet is empty, not broken.
    return []
  }
  const papers: PaperSummary[] = []
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : ''
    if (!PAPER_ID.test(id)) continue
    let document: PaperDocument
    try {
      document = await readDocument(root, id)
    } catch (error) {
      // One corrupt document must not hide the rest of the library.
      console.warn(`[paper-reader] skipping unreadable ${name}`, error)
      continue
    }
    papers.push(summarize(id, document))
  }
  return papers.sort((left, right) => right.addedAt.localeCompare(left.addedAt))
}

/**
 * Handle one paper-library request.
 * @param root - absolute library directory.
 * @param maxBytes - largest accepted upload.
 * @param req - incoming request.
 * @param res - server response.
 */
export async function handlePaperRequest(
  root: string,
  maxBytes: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://paper-reader')
  const rest = url.pathname.slice(PAPER_READER_ROUTE.length)
  const method = req.method ?? 'GET'
  try {
    if (rest === '/papers' && method === 'GET') {
      sendJson(res, 200, { papers: await listPapers(root) })
      return
    }

    if (rest === '/papers' && method === 'POST') {
      const bytes = await readBody(req, maxBytes)
      if (!isPdf(bytes)) throw new PaperRequestError(400, 'paper: upload is not a PDF')
      const id = randomUUID()
      const document: PaperDocument = {
        name: displayName(url.searchParams.get('name')),
        size: bytes.length,
        addedAt: new Date().toISOString(),
        annotations: [],
      }
      await mkdir(root, { recursive: true })
      await writeFile(join(root, `${id}.pdf`), bytes)
      await writeFile(join(root, `${id}.json`), JSON.stringify(document, null, 2))
      sendJson(res, 200, { paper: recordOf(id, document) })
      return
    }

    const segments = rest.startsWith('/papers/') ? rest.slice('/papers/'.length).split('/') : []
    const id = segments[0]
    if (id === undefined || !PAPER_ID.test(id)) {
      throw new PaperRequestError(404, `paper: unknown route ${method} ${url.pathname}`)
    }
    if (segments.length === 1 && method === 'GET') {
      const document = await readDocument(root, id)
      sendJson(res, 200, { paper: recordOf(id, document) })
      return
    }
    if (segments.length === 2 && segments[1] === 'file' && method === 'GET') {
      let bytes: Buffer
      try {
        bytes = await readFile(join(root, `${id}.pdf`))
      } catch {
        throw new PaperRequestError(404, 'paper: unknown paper')
      }
      res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store' })
      res.end(bytes)
      return
    }
    if (segments.length === 2 && segments[1] === 'annotations' && method === 'PUT') {
      const document = await readDocument(root, id)
      const body: unknown = JSON.parse((await readBody(req, maxBytes)).toString('utf8'))
      const annotations = parseAnnotations(body)
      const updated: PaperDocument = { ...document, annotations }
      await writeFile(join(root, `${id}.json`), JSON.stringify(updated, null, 2))
      sendJson(res, 200, { paper: recordOf(id, updated) })
      return
    }
    if (segments.length === 1 && method === 'DELETE') {
      await rm(join(root, `${id}.pdf`), { force: true })
      await rm(join(root, `${id}.json`), { force: true })
      sendJson(res, 200, { ok: true })
      return
    }
    throw new PaperRequestError(404, `paper: unknown route ${method} ${url.pathname}`)
  } catch (error) {
    if (error instanceof PaperRequestError) {
      sendJson(res, error.status, { error: error.message })
      return
    }
    // An unexpected fault reaches the reader as one opaque diagnostic line.
    sendJson(res, 500, { error: String(error) })
  }
}
