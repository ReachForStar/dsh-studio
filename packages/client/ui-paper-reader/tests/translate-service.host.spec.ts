/** Host half of paper translation: request validation, NDJSON framing, and route walking. */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { PAPER_READER_ROUTE } from '../src/route.ts'
import {
  createPaperTranslator, handleTranslateRequest, type PaperTranslator,
} from '../src/translate-service.ts'

const ENDPOINT = `${PAPER_READER_ROUTE}/translate`
const BODY_CAP = 512 * 1024
const TEXT_MAX = 200_000

interface ResponseDouble {
  readonly res: unknown
  readonly status: number
  readonly headers: Record<string, string>
  readonly ended: boolean
  text(): string
  close(): void
}

/** Response double: records the head and every written chunk, exposes the close listener. */
function responseDouble(): ResponseDouble {
  let statusCode = 0
  let headers: Record<string, string> = {}
  let ended = false
  let onClose: (() => void) | undefined
  const chunks: string[] = []
  return {
    res: {
      writeHead(status: number, values?: Record<string, string>) {
        statusCode = status
        headers = values ?? {}
      },
      write(text: string) {
        chunks.push(text)
        return true
      },
      end(payload?: string) {
        if (payload !== undefined) chunks.push(payload)
        ended = true
      },
      on(event: string, listener: () => void) {
        if (event === 'close') onClose = listener
        return this
      },
    },
    get status(): number { return statusCode },
    get headers(): Record<string, string> { return headers },
    get ended(): boolean { return ended },
    text(): string { return chunks.join('') },
    close(): void { onClose?.() },
  }
}

/** Request double: one body chunk then end, or a stream that only faults. */
function requestDouble(
  method: string,
  path: string,
  body?: string,
  mode: 'ok' | 'fault' | 'never' = 'ok',
) {
  let onError: ((error: Error) => void) | undefined
  return {
    url: path,
    method,
    on(event: 'data' | 'end' | 'error', listener: (chunk?: Buffer) => void) {
      if (mode === 'ok') {
        if (event === 'data' && body !== undefined) listener(Buffer.from(body))
        if (event === 'end') listener()
      }
      if (event === 'error') onError = listener as unknown as (error: Error) => void
      return this
    },
    destroy() {},
    emitError(error: Error) { onError?.(error) },
  }
}

/** Read the error text of one JSON error response. */
function errorOf(text: string): string {
  return (JSON.parse(text) as { error: string }).error
}

/** Decode every NDJSON line of one response. */
function events(text: string): unknown[] {
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as unknown)
}

/** Invoke the handler with one stub translator and return its response double. */
async function call(
  translator: PaperTranslator,
  options: {
    readonly method?: string
    readonly path?: string
    readonly body?: string
    readonly mode?: 'ok' | 'fault' | 'never'
    readonly request?: ReturnType<typeof requestDouble>
  } = {},
): Promise<ResponseDouble> {
  const response = responseDouble()
  await handleTranslateRequest(
    translator,
    (options.request ?? requestDouble(
      options.method ?? 'POST', options.path ?? ENDPOINT, options.body, options.mode ?? 'ok',
    )) as never,
    response.res as never,
  )
  return response
}

/** A translator that runs one scripted body. */
function translatorOf(run: PaperTranslator['translate']): PaperTranslator {
  return { translate: run }
}

const OK = translatorOf(async (_request, onDelta) => { onDelta('translated') })

describe('handleTranslateRequest framing', () => {
  it('streams delta lines and finishes with NDJSON', async () => {
    const response = await call(translatorOf(async (_request, onDelta) => {
      onDelta('你好')
      onDelta('世界')
    }), { body: JSON.stringify({ text: 'hello', target: 'zh' }) })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/x-ndjson; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(events(response.text())).toEqual([
      { type: 'delta', text: '你好' },
      { type: 'delta', text: '世界' },
      { type: 'finish' },
    ])
    expect(response.ended).toBe(true)
  })

  it('passes the validated request to the translator', async () => {
    const seen: unknown[] = []
    await call(translatorOf(async (request) => { seen.push(request) }),
      { body: JSON.stringify({ text: 'hello', target: 'en' }) })
    expect(seen).toEqual([{ text: 'hello', target: 'en' }])
  })

  it('answers a pre-delta failure with a JSON 502 and no stream head', async () => {
    const response = await call(translatorOf(async () => {
      throw new Error('no credentials')
    }), { body: JSON.stringify({ text: 'hello', target: 'en' }) })
    expect(response.status).toBe(502)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(JSON.parse(response.text())).toEqual({ error: 'Error: no credentials' })
  })

  it('reports a post-delta failure as an error line after the deltas', async () => {
    const response = await call(translatorOf(async (_request, onDelta) => {
      onDelta('部分')
      throw new Error('stream broke')
    }), { body: JSON.stringify({ text: 'hello', target: 'en' }) })
    expect(response.status).toBe(200)
    expect(events(response.text())).toEqual([
      { type: 'delta', text: '部分' },
      { type: 'error', message: 'stream broke' },
    ])
    expect(response.ended).toBe(true)
  })

  it('reports a non-Error failure after deltas as text', async () => {
    const response = await call(translatorOf(async (_request, onDelta) => {
      onDelta('部分')
      throw 'plain stream failure'
    }), { body: JSON.stringify({ text: 'hello', target: 'en' }) })
    expect(events(response.text())).toEqual([
      { type: 'delta', text: '部分' },
      { type: 'error', message: 'plain stream failure' },
    ])
  })

  it('stops without an error line when the client closes the response', async () => {
    const response = responseDouble()
    const pending = handleTranslateRequest(
      translatorOf(async (_request, onDelta, signal) => {
        onDelta('部分')
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }) })
        throw new Error('aborted')
      }),
      requestDouble('POST', ENDPOINT, JSON.stringify({ text: 'hello', target: 'en' })) as never,
      response.res as never,
    )
    await vi.waitFor(() => { expect(response.text()).not.toBe('') })
    response.close()
    await pending
    expect(response.ended).toBe(true)
    expect(events(response.text())).toEqual([{ type: 'delta', text: '部分' }])
  })
})

describe('handleTranslateRequest validation', () => {
  it('rejects any other method or path', async () => {
    for (const options of [{ method: 'GET' }, { path: `${PAPER_READER_ROUTE}/papers` }]) {
      const response = await call(OK, { ...options, body: '{}' })
      expect(response.status).toBe(404)
      expect(errorOf(response.text())).toMatch(/paper: unknown route/)
    }
  })

  it('rejects a request that carries neither a URL nor a method', async () => {
    const response = await call(OK, {
      request: { on() { return this } } as unknown as ReturnType<typeof requestDouble>,
    })
    expect(response.status).toBe(404)
    expect(errorOf(response.text())).toBe('paper: unknown route GET /')
  })

  it('rejects a body that is not JSON', async () => {
    const response = await call(OK, { body: 'not json' })
    expect(response.status).toBe(400)
    expect(errorOf(response.text())).toMatch(/must be JSON/)
  })

  it('rejects a non-object body', async () => {
    const response = await call(OK, { body: '[1,2]' })
    expect(response.status).toBe(400)
    expect(errorOf(response.text())).toMatch(/must be an object/)
  })

  it('rejects missing, non-string, and blank text', async () => {
    for (const text of [undefined, 7, '   ']) {
      const response = await call(OK, { body: JSON.stringify({ text, target: 'en' }) })
      expect(response.status).toBe(400)
      expect(errorOf(response.text())).toMatch(/non-empty string/)
    }
  })

  it('rejects text beyond the protocol bound', async () => {
    const response = await call(OK, { body: JSON.stringify({ text: 'x'.repeat(TEXT_MAX + 1), target: 'en' }) })
    expect(response.status).toBe(413)
    expect(errorOf(response.text())).toMatch(/exceeds 200000 characters/)
  })

  it('rejects an unsupported target language', async () => {
    const response = await call(OK, { body: JSON.stringify({ text: 'hello', target: 'ja' }) })
    expect(response.status).toBe(400)
    expect(errorOf(response.text())).toMatch(/"zh" or "en"/)
  })

  it('rejects a body beyond the byte cap before parsing it', async () => {
    const response = await call(OK, { body: 'x'.repeat(BODY_CAP + 1) })
    expect(response.status).toBe(413)
    expect(errorOf(response.text())).toMatch(/request exceeds/)
  })

  it('answers an unexpected read fault with an opaque 500', async () => {
    const request = requestDouble('POST', ENDPOINT, undefined, 'fault')
    const response = responseDouble()
    const pending = handleTranslateRequest(OK, request as never, response.res as never)
    await Promise.resolve()
    request.emitError(new Error('socket broke'))
    await pending
    expect(response.status).toBe(500)
    expect(errorOf(response.text())).toContain('socket broke')
  })
})

/** Build a fake llm service over a provider catalog and provider-scripted streams. */
function llmContext(
  catalog: Record<string, { id: string; name: string }[]>,
  streams: Record<string, () => AsyncIterable<unknown>>,
  onRequest?: (options: unknown) => void,
): Context {
  return {
    llm: {
      listProviders: () => Object.keys(catalog).map(id => ({ id })),
      listModels: async (provider: string) => catalog[provider] ?? [],
      stream: (options: { provider: string }) => {
        onRequest?.(options)
        const open = streams[options.provider]
        if (open === undefined) throw new Error(`no stream scripted for ${options.provider}`)
        return open()
      },
    },
  } as unknown as Context
}

const TEXT = (text: string) => ({ type: 'text-delta', index: 0, text })
const FINISH = (kind = 'stop') => ({ type: 'finish', reason: { kind } })

/** One scripted stream that emits the given chunks. */
function emit(chunks: readonly unknown[]): () => AsyncIterable<unknown> {
  return async function* () {
    for (const chunk of chunks) yield chunk
  }
}

/** A stream that fails before emitting anything. */
function fail(error: unknown): () => AsyncIterable<unknown> {
  return async function* () {
    throw error
  }
}

const REQUEST = { text: 'hello', target: 'en' } as const

describe('createPaperTranslator', () => {
  it('streams the first route with the target language in the system prompt', async () => {
    const options: { system?: string; temperature?: number }[] = []
    const ctx = llmContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }] },
      { gateway: emit([TEXT('Hel'), TEXT('lo'), FINISH()]) },
      (value) => { options.push(value as { system?: string; temperature?: number }) },
    )
    const deltas: string[] = []
    await createPaperTranslator(ctx).translate({ text: '你好', target: 'en' }, (text) => { deltas.push(text) },
      new AbortController().signal)
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(options[0]?.system).toContain('Translate into English.')
    expect(options[0]?.temperature).toBe(0)
  })

  it('names Chinese for a zh target', async () => {
    const options: { system?: string }[] = []
    const ctx = llmContext({ gateway: [{ id: 'm1', name: 'Model 1' }] },
      { gateway: emit([TEXT('ok'), FINISH()]) }, (value) => { options.push(value as { system?: string }) })
    await createPaperTranslator(ctx).translate({ ...REQUEST, target: 'zh' }, () => {}, new AbortController().signal)
    expect(options[0]?.system).toContain('Translate into Simplified Chinese.')
  })

  it('falls through to the next route when one fails before emitting', async () => {
    const ctx = llmContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }], mirror: [{ id: 'm2', name: 'Model 2' }] },
      { gateway: fail(new Error('no credentials')), mirror: emit([TEXT('bonjour'), FINISH()]) },
    )
    const deltas: string[] = []
    await createPaperTranslator(ctx).translate(REQUEST, (text) => { deltas.push(text) },
      new AbortController().signal)
    expect(deltas).toEqual(['bonjour'])
  })

  it('does not fall through once a delta reached the client', async () => {
    const ctx = llmContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }], mirror: [{ id: 'm2', name: 'Model 2' }] },
      {
        gateway: async function* () {
          yield TEXT('part')
          throw new Error('stream broke')
        },
        mirror: emit([TEXT('duplicate'), FINISH()]),
      },
    )
    await expect(createPaperTranslator(ctx).translate(REQUEST, () => {}, new AbortController().signal))
      .rejects.toThrow('stream broke')
  })

  it('describes a non-Error route failure and still tries the next route', async () => {
    const ctx = llmContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }], mirror: [{ id: 'm2', name: 'Model 2' }] },
      { gateway: fail('plain failure'), mirror: emit([TEXT('ok'), FINISH()]) },
    )
    await expect(createPaperTranslator(ctx).translate(REQUEST, () => {}, new AbortController().signal))
      .resolves.toBeUndefined()
    const failing = llmContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }] },
      { gateway: fail('plain failure') },
    )
    await expect(createPaperTranslator(failing).translate(REQUEST, () => {}, new AbortController().signal))
      .rejects.toThrow(/gateway\/m1: plain failure/)
  })

  it('reports a non-Error failure after the first delta as its text', async () => {
    const ctx = llmContext({ gateway: [{ id: 'm1', name: 'Model 1' }] }, {
      gateway: async function* () {
        yield TEXT('part')
        throw 'plain stream failure'
      },
    })
    await expect(createPaperTranslator(ctx).translate(REQUEST, () => {}, new AbortController().signal))
      .rejects.toBe('plain stream failure')
  })

  it('reports every failed route when none produces text', async () => {
    const ctx = llmContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }], mirror: [{ id: 'm2', name: 'Model 2' }] },
      { gateway: fail(new Error('no credentials')), mirror: fail(new Error('offline')) },
    )
    await expect(createPaperTranslator(ctx).translate(REQUEST, () => {}, new AbortController().signal))
      .rejects.toThrow(/no model produced a translation — gateway\/m1: no credentials; mirror\/m2: offline/)
  })

  it('rejects an abnormal finish reason', async () => {
    const ctx = llmContext({ gateway: [{ id: 'm1', name: 'Model 1' }] },
      { gateway: emit([TEXT('partial'), FINISH('length')]) })
    await expect(createPaperTranslator(ctx).translate(REQUEST, () => {}, new AbortController().signal))
      .rejects.toThrow(/ended with length/)
  })

  it('rejects a stream without a terminal finish', async () => {
    const ctx = llmContext({ gateway: [{ id: 'm1', name: 'Model 1' }] }, { gateway: emit([TEXT('partial')]) })
    await expect(createPaperTranslator(ctx).translate(REQUEST, () => {}, new AbortController().signal))
      .rejects.toThrow(/no terminal finish/)
  })

  it('rejects an empty translation', async () => {
    const ctx = llmContext({ gateway: [{ id: 'm1', name: 'Model 1' }] }, { gateway: emit([FINISH()]) })
    await expect(createPaperTranslator(ctx).translate(REQUEST, () => {}, new AbortController().signal))
      .rejects.toThrow(/returned no text/)
  })

  it('returns without text checks once the request is aborted', async () => {
    const life = new AbortController()
    const ctx = llmContext({ gateway: [{ id: 'm1', name: 'Model 1' }] }, {
      gateway: async function* () {
        yield TEXT('part')
        life.abort()
      },
    })
    await expect(createPaperTranslator(ctx).translate(REQUEST, () => {}, life.signal)).resolves.toBeUndefined()
  })
})
