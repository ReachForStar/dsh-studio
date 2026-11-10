/**
 * The paper library's browser client. Every request is document-relative so
 * the reader works under any mount prefix.
 */
import { PAPER_READER_CLIENT_ROUTE, PAPER_TRANSLATE_CLIENT_ROUTE } from '../route.ts'
import type {
  PaperAnnotation, PaperRecord, PaperSummary, PaperTranslateEvent, PaperTranslateRequest,
} from '../types.ts'

/** One library response carrying every stored paper. */
interface PaperListResponse {
  readonly papers: readonly PaperSummary[]
}

/** One library response carrying a single paper. */
interface PaperResponse {
  readonly paper: PaperRecord
}

/**
 * Send one request and decode its JSON body.
 * @param path - path below the library prefix.
 * @param init - fetch options; the caller owns the abort signal.
 * @returns the decoded body.
 * @throws {Error} with the server's status when the response is not successful.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${PAPER_READER_CLIENT_ROUTE}${path}`, init)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`paper-reader: ${String(response.status)} ${detail}`.trim())
  }
  return response.json() as Promise<T>
}

/**
 * List the stored papers.
 * @param signal - request lifetime.
 * @returns summaries ordered newest first.
 */
export async function listPapers(signal: AbortSignal): Promise<readonly PaperSummary[]> {
  return (await request<PaperListResponse>('/papers', { signal })).papers
}

/**
 * Store one uploaded PDF.
 * @param file - browser-selected PDF.
 * @param signal - request lifetime.
 * @returns the stored record.
 */
export async function uploadPaper(file: File, signal: AbortSignal): Promise<PaperRecord> {
  return (await request<PaperResponse>(`/papers?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', body: file, signal,
  })).paper
}

/**
 * Read one paper with its annotations.
 * @param id - paper identity.
 * @param signal - request lifetime.
 * @returns the stored record.
 */
export async function readPaper(id: string, signal: AbortSignal): Promise<PaperRecord> {
  return (await request<PaperResponse>(`/papers/${id}`, { signal })).paper
}

/**
 * Read one paper's stored PDF bytes.
 * @param id - paper identity.
 * @param signal - request lifetime.
 * @returns the complete PDF file.
 */
export async function readPaperBytes(id: string, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(`${PAPER_READER_CLIENT_ROUTE}/papers/${id}/file`, { signal })
  if (!response.ok) throw new Error(`paper-reader: ${String(response.status)} reading paper ${id}`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Remove one paper and its annotations.
 * @param id - paper identity.
 * @param signal - request lifetime.
 */
export async function deletePaper(id: string, signal: AbortSignal): Promise<void> {
  await request<{ readonly ok: true }>(`/papers/${id}`, { method: 'DELETE', signal })
}

/**
 * Replace one paper's annotation list.
 * @param id - paper identity.
 * @param annotations - the complete list to persist.
 * @param signal - request lifetime.
 * @returns the stored record.
 */
export async function writeAnnotations(
  id: string,
  annotations: readonly PaperAnnotation[],
  signal: AbortSignal,
): Promise<PaperRecord> {
  return (await request<PaperResponse>(`/papers/${id}/annotations`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ annotations }),
    signal,
  })).paper
}

/**
 * Validate one NDJSON line of a translation response.
 * @param line - one complete line without its newline.
 * @returns the decoded event.
 * @throws {Error} when the line is not a known translation event.
 */
function parseTranslateEvent(line: string): PaperTranslateEvent {
  const value: unknown = JSON.parse(line)
  if (typeof value !== 'object' || value === null) throw new Error('paper-reader: malformed translation event')
  const event = value as Record<string, unknown>
  if (event.type === 'delta' && typeof event.text === 'string') return { type: 'delta', text: event.text }
  if (event.type === 'finish') return { type: 'finish' }
  if (event.type === 'error' && typeof event.message === 'string') return { type: 'error', message: event.message }
  throw new Error('paper-reader: malformed translation event')
}

/**
 * Translate text through the Host's LLM route, streaming deltas as they arrive.
 * @param request - text and target language.
 * @param signal - request lifetime.
 * @param onDelta - receives each text delta in arrival order.
 * @returns the complete translation.
 * @throws {Error} with the server's status, or the stream's own error message.
 */
export async function translateText(
  request: PaperTranslateRequest,
  signal: AbortSignal,
  onDelta: (text: string) => void,
): Promise<string> {
  const response = await fetch(PAPER_TRANSLATE_CLIENT_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`paper-reader: ${String(response.status)} ${detail}`.trim())
  }
  if (response.body === null) throw new Error('paper-reader: translation response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let text = ''
  // Held in an object so TypeScript does not narrow the flag across the awaits.
  const state = { finished: false }
  const consume = (line: string): void => {
    if (line === '') return
    const event = parseTranslateEvent(line)
    if (event.type === 'delta') {
      text += event.text
      onDelta(event.text)
    }
    if (event.type === 'finish') state.finished = true
    if (event.type === 'error') throw new Error(event.message)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const lines = buffered.split('\n')
    /* v8 ignore next -- split always yields at least one element, so pop cannot return undefined. */
    buffered = lines.pop() ?? ''
    for (const line of lines) consume(line)
  }
  buffered += decoder.decode()
  consume(buffered)
  if (!state.finished && !signal.aborted) throw new Error('paper-reader: translation stream ended before finishing')
  return text
}
