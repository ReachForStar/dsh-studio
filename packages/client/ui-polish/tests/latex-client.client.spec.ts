// @vitest-environment jsdom
/** LaTeX panel HTTP client: URL building, JSON helpers, the writing stream, and the api table. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiStream, latexApi, latexCall, latexUrl } from '../src/client/latex-client.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** JSON response double. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** JSON response whose body cannot be parsed. */
function brokenResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new SyntaxError('not json') },
  } as unknown as Response
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

/** Capture the request a stubbed fetch received. */
function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('latexUrl', () => {
  it('always carries cwd and appends extra parameters', () => {
    expect(latexUrl('/latex/pdf', '/ws')).toBe('/latex/pdf?cwd=%2Fws')
    expect(latexUrl('/latex/pdf', '/ws', { dir: 'paper', t: '3' })).toBe('/latex/pdf?cwd=%2Fws&dir=paper&t=3')
  })
})

describe('latexCall', () => {
  it('posts the merged body and returns the payload', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { ok: true }))
    await expect(latexCall('/latex/compile', '/ws', { dir: '.', main: 'main.tex' })).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('/latex/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/ws', dir: '.', main: 'main.tex' }),
    })
  })

  it('omits an absent body', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { projects: [] }))
    await latexCall('/latex/projects', '/ws')
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ cwd: '/ws' })
  })

  it('throws the body error text, or the HTTP status when absent', async () => {
    stubFetch(jsonResponse(400, { error: 'no engine' }))
    await expect(latexCall('/latex/compile', '/ws')).rejects.toThrow('no engine')
    stubFetch(jsonResponse(500, {}))
    await expect(latexCall('/latex/compile', '/ws')).rejects.toThrow('latex panel: HTTP 500')
    stubFetch(brokenResponse(502))
    await expect(latexCall('/latex/compile', '/ws')).rejects.toThrow('latex panel: HTTP 502')
  })
})

describe('aiStream', () => {
  const ARGS = ['/ws', '.', 'main.tex', undefined, 'tighten', [], 'tok'] as const

  it('streams deltas and resolves the done message', async () => {
    const fetchMock = stubFetch(streamResponse(['{"t":"text","x":"\\\\alpha"}\n', '{"t":"done","m":"\\\\alpha"}\n']))
    const deltas: string[] = []
    await expect(aiStream('/ws', '.', 'main.tex', 'selected', 'tighten', [{ role: 'user', text: 'hi' }], 'tok', d => deltas.push(d), 'm1'))
      .resolves.toBe('\\alpha')
    expect(deltas).toEqual(['\\alpha'])
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      cwd: '/ws',
      dir: '.',
      path: 'main.tex',
      token: 'tok',
      instruction: 'tighten',
      history: [{ role: 'user', text: 'hi' }],
      selection: 'selected',
      model: 'm1',
    })
  })

  it('omits the optional selection and model', async () => {
    const fetchMock = stubFetch(streamResponse(['{"t":"done"}\n']))
    await expect(aiStream(...ARGS, () => {})).resolves.toBe('')
    const sent = fetchMock.mock.calls[0]?.[1]?.body as string
    expect(JSON.parse(sent)).not.toHaveProperty('selection')
    expect(JSON.parse(sent)).not.toHaveProperty('model')
  })

  it('returns the collected text on done without a message, or on stop', async () => {
    stubFetch(streamResponse(['{"t":"text","x":"part"}\n{"t":"done"}\n']))
    await expect(aiStream(...ARGS, () => {})).resolves.toBe('part')
    stubFetch(streamResponse(['{"t":"text","x":"half"}\n{"t":"stop"}\n']))
    await expect(aiStream(...ARGS, () => {})).resolves.toBe('half')
  })

  it('skips blank lines, ignores a non-string payload, and reassembles split lines', async () => {
    stubFetch(streamResponse(['\n{"t":"te', 'xt","x":5}\n{"t":"done","m":"ok"}\n', '\n']))
    await expect(aiStream(...ARGS, () => {})).resolves.toBe('ok')
  })

  it('rejects on an err event with or without a message', async () => {
    stubFetch(streamResponse(['{"t":"err","e":"quota"}\n']))
    await expect(aiStream(...ARGS, () => {})).rejects.toThrow('quota')
    stubFetch(streamResponse(['{"t":"err"}\n']))
    await expect(aiStream(...ARGS, () => {})).rejects.toThrow(/writing failed/)
  })

  it('rejects when the stream closes without a result', async () => {
    stubFetch(streamResponse(['{"t":"text","x":"x"}\n']))
    await expect(aiStream(...ARGS, () => {})).rejects.toThrow(/closed without a result/)
  })

  it('rejects a refused request with the body error text or HTTP status', async () => {
    stubFetch(jsonResponse(409, { error: 'busy' }))
    await expect(aiStream(...ARGS, () => {})).rejects.toThrow('busy')
    stubFetch(jsonResponse(500, {}))
    await expect(aiStream(...ARGS, () => {})).rejects.toThrow('latex panel: HTTP 500')
    stubFetch(brokenResponse(500))
    await expect(aiStream(...ARGS, () => {})).rejects.toThrow('latex panel: HTTP 500')
    stubFetch({ ok: true, status: 200, body: null, json: async () => ({ error: 'no body' }) } as unknown as Response)
    await expect(aiStream(...ARGS, () => {})).rejects.toThrow('no body')
  })
})

describe('latexApi', () => {
  const CASES: { name: string; run: () => Promise<unknown>; url: string; body?: Record<string, unknown> }[] = [
    { name: 'projects', run: () => latexApi.projects('/ws'), url: '/latex/projects', body: { cwd: '/ws' } },
    { name: 'list', run: () => latexApi.list('/ws', '.'), url: '/latex/list', body: { cwd: '/ws', dir: '.' } },
    { name: 'read', run: () => latexApi.read('/ws', '.', 'main.tex'), url: '/latex/read', body: { cwd: '/ws', dir: '.', path: 'main.tex' } },
    { name: 'write', run: () => latexApi.write('/ws', '.', 'main.tex', 'x'), url: '/latex/write', body: { cwd: '/ws', dir: '.', path: 'main.tex', content: 'x' } },
    { name: 'compile', run: () => latexApi.compile('/ws', '.', 'main.tex'), url: '/latex/compile', body: { cwd: '/ws', dir: '.', main: 'main.tex' } },
    { name: 'clean', run: () => latexApi.clean('/ws', '.'), url: '/latex/clean', body: { cwd: '/ws', dir: '.' } },
    { name: 'fontList', run: () => latexApi.fontList('/ws', '.'), url: '/latex/fonts', body: { cwd: '/ws', dir: '.', op: 'list' } },
    { name: 'fontInstall', run: () => latexApi.fontInstall('/ws', '.', 'f.ttf', 'AA'), url: '/latex/fonts', body: { cwd: '/ws', dir: '.', op: 'install', name: 'f.ttf', data: 'AA' } },
    { name: 'fontInstallPackage', run: () => latexApi.fontInstallPackage('/ws', '.', 'ctex'), url: '/latex/fonts', body: { cwd: '/ws', dir: '.', op: 'install-package', name: 'ctex' } },
    { name: 'aiCancel', run: () => latexApi.aiCancel('tok'), url: '/latex/ai-cancel', body: { cwd: '', token: 'tok' } },
  ]

  it.each(CASES)('$name posts to $url', async ({ run, url, body }) => {
    const fetchMock = stubFetch(jsonResponse(200, { ok: true }))
    await run()
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(target).toBe(url)
    expect(init.method).toBe('POST')
    const sent = init.body
    if (typeof sent !== 'string') throw new Error('expected a JSON string body')
    expect(JSON.parse(sent)).toEqual(body)
  })

  it('pdfUrl renders a cache-busting reference', () => {
    expect(latexApi.pdfUrl('/ws', 'paper', 'main.tex', 7)).toBe('/latex/pdf?cwd=%2Fws&dir=paper&main=main.tex&t=7')
  })

  it('models is a GET route', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { models: [] }))
    await expect(latexApi.models()).resolves.toEqual({ models: [] })
    expect(fetchMock).toHaveBeenCalledWith('/latex/models')
  })

  it('models reports a refused request', async () => {
    stubFetch(jsonResponse(500, { error: 'no llm' }))
    await expect(latexApi.models()).rejects.toThrow('no llm')
    stubFetch(jsonResponse(500, {}))
    await expect(latexApi.models()).rejects.toThrow('latex panel: HTTP 500')
    stubFetch(brokenResponse(500))
    await expect(latexApi.models()).rejects.toThrow('latex panel: HTTP 500')
  })

  it('ai forwards to the stream', async () => {
    stubFetch(streamResponse(['{"t":"done","m":"ok"}\n']))
    await expect(latexApi.ai('/ws', '.', 'main.tex', undefined, 'go', [], 'tok', () => {})).resolves.toBe('ok')
  })
})
