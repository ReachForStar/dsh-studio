/**
 * Host half of paper translation: one NDJSON route over the LLM service.
 *
 * `POST /paper-reader/translate` takes `{ text, target }` and answers one JSON
 * line per event: `delta` lines as the model streams, then `finish`. A failure
 * before the first delta is a JSON error response with a 5xx status; a failure
 * after text reached the client is an `error` line, because the status is
 * already sent. Candidate routes come from the LLM catalog in provider order,
 * so a provider with missing credentials falls through to the next one.
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import { llmRouteCandidates, type LlmRoute } from '@deepseek-ai/dsh-llm/route'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PaperRequestError, readBody, sendJson } from './http.ts'
import { PAPER_TRANSLATE_ROUTE } from './route.ts'
import type { PaperTranslateEvent, PaperTranslateRequest, PaperTranslateTarget } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Paper translation requests this package issues on the user's behalf.
     * Readers preserve the message without the producer.
     * @persistenceAttribution
     */
    'paper-reader': { kind: 'paper-reader' }
  }
}

/** Largest accepted translation request body; one JSON envelope around the text. */
const MAX_TRANSLATE_BODY_BYTES = 512 * 1024

/** Longest text accepted from one request, in UTF-16 code units. */
const MAX_TRANSLATE_TEXT = 200_000

/** The language each supported target names for the model. */
const TARGET_LANGUAGE: Readonly<Record<PaperTranslateTarget, string>> = {
  zh: 'Simplified Chinese',
  en: 'English',
}

/** Instructions that keep the answer to the translation alone. */
const SYSTEM_PROMPT = 'You translate research-paper text. Preserve paragraph breaks, formulas, citation markers, and '
  + 'technical terms. Do not summarise, explain, or add anything. Output only the translation.'

/** Response head used once the first delta is ready. */
const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** Streams one translation; the HTTP surface owns request parsing and framing. */
export interface PaperTranslator {
  /**
   * Translate one request through the first route that produces text.
   * @param request - text and target language, already validated.
   * @param onDelta - receives each text delta in arrival order.
   * @param signal - aborts the model call when the client goes away.
   * @returns resolution after the model finished.
   * @throws {Error} when no route produced text.
   */
  translate(
    request: PaperTranslateRequest,
    onDelta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<void>
}

/**
 * Build the translator over a Host context's LLM service.
 * @param ctx - Host context providing `llm`.
 * @returns the translator the route invokes per request.
 */
export function createPaperTranslator(ctx: Context): PaperTranslator {
  return {
    async translate(request, onDelta, signal) {
      const candidates = await llmRouteCandidates(ctx)
      const failures: string[] = []
      for (const route of candidates) {
        // Held in an object so the delta callback's write is visible here:
        // TypeScript narrows a local `let` to its initializer across the await.
        const state = { emitted: false }
        try {
          await streamRoute(ctx, route, request, (text) => {
            state.emitted = true
            onDelta(text)
          }, signal)
          return
        } catch (error) {
          // Deltas already sent cannot be withdrawn, so another route would
          // print the translation twice; an aborted request ends the walk too.
          if (state.emitted || signal.aborted) throw error
          failures.push(`${route.provider}/${route.model}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      throw new Error(`paper translate: no model produced a translation — ${failures.join('; ')}`)
    },
  }
}

/**
 * Stream one translation through one route.
 * @param ctx - Host context providing `llm`.
 * @param route - provider/model pair to stream with.
 * @param request - text and target language.
 * @param onDelta - receives each text delta in arrival order.
 * @param signal - aborts the model call.
 * @throws {Error} when the stream ends abnormally or returns no text.
 */
async function streamRoute(
  ctx: Context,
  route: LlmRoute,
  request: PaperTranslateRequest,
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const assembler = new BlockAssembler()
  let finished = false
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system: `${SYSTEM_PROMPT} Translate into ${TARGET_LANGUAGE[request.target]}.`,
    messages: [createUserMessage({
      content: [{ type: 'text', text: request.text }],
      source: { kind: 'paper-reader' },
    })],
    temperature: 0,
    signal,
  })
  for await (const chunk of stream) {
    assembler.push(chunk)
    if (chunk.type === 'text-delta') onDelta(chunk.text)
    if (chunk.type === 'finish') {
      finished = true
      if (chunk.reason.kind !== 'stop' && !signal.aborted) {
        throw new Error(`paper translate: model ended with ${chunk.reason.kind}`)
      }
    }
  }
  if (!finished && !signal.aborted) throw new Error('paper translate: model stream emitted no terminal finish')
  if (signal.aborted) return
  const text = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => (block as { text: string }).text)
    .join('')
    .trim()
  if (text === '') throw new Error('paper translate: model returned no text')
}

/**
 * Validate one decoded translation body.
 * @param value - decoded JSON value.
 * @returns the text and target to translate into.
 * @throws {PaperRequestError} when a field is missing, empty, or out of range.
 */
function parseTranslateRequest(value: unknown): PaperTranslateRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PaperRequestError(400, 'paper: translate body must be an object')
  }
  const { text, target } = value as Record<string, unknown>
  if (typeof text !== 'string' || text.trim() === '') {
    throw new PaperRequestError(400, 'paper: translate text must be a non-empty string')
  }
  if (text.length > MAX_TRANSLATE_TEXT) {
    throw new PaperRequestError(413, `paper: translate text exceeds ${String(MAX_TRANSLATE_TEXT)} characters`)
  }
  if (target !== 'zh' && target !== 'en') {
    throw new PaperRequestError(400, 'paper: translate target must be "zh" or "en"')
  }
  return { text, target }
}

/**
 * Handle one `/paper-reader/translate` request.
 * @param translator - the LLM bridge bound to the Host context.
 * @param req - incoming request.
 * @param res - server response.
 */
export async function handleTranslateRequest(
  translator: PaperTranslator,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://paper-reader')
  // A client that navigated away must stop the model call, not just the write.
  const lifetime = new AbortController()
  res.on('close', () => { lifetime.abort() })
  // Held in an object so TypeScript does not narrow the flag across the awaits.
  const streamed = { opened: false }
  const emit = (event: PaperTranslateEvent): void => {
    if (!streamed.opened) {
      res.writeHead(200, NDJSON_HEADERS)
      streamed.opened = true
    }
    res.write(`${JSON.stringify(event)}\n`)
  }
  try {
    if (url.pathname !== PAPER_TRANSLATE_ROUTE || req.method !== 'POST') {
      throw new PaperRequestError(404, `paper: unknown route ${req.method ?? 'GET'} ${url.pathname}`)
    }
    const raw = await readBody(req, MAX_TRANSLATE_BODY_BYTES)
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new PaperRequestError(400, 'paper: translate body must be JSON')
    }
    const request = parseTranslateRequest(body)
    try {
      await translator.translate(request, (text) => { emit({ type: 'delta', text }) }, lifetime.signal)
    } catch (error) {
      // An aborted request has no reader left to answer.
      if (lifetime.signal.aborted) {
        res.end()
        return
      }
      if (!streamed.opened) {
        sendJson(res, 502, { error: String(error) })
        return
      }
      emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      res.end()
      return
    }
    emit({ type: 'finish' })
    res.end()
  } catch (error) {
    if (error instanceof PaperRequestError) {
      sendJson(res, error.status, { error: error.message })
      return
    }
    // An unexpected fault reaches the reader as one opaque diagnostic line.
    sendJson(res, 500, { error: String(error) })
  }
}
