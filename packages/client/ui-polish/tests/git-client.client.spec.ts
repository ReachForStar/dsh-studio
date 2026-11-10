// @vitest-environment jsdom
/** Git panel HTTP client: URL building, JSON helpers, NDJSON generation, and the api table. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitApi, gitGenerate, gitGet, gitPost, gitUrl } from '../src/client/git-client.ts'

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
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('gitUrl', () => {
  it('always carries cwd and appends extra parameters', () => {
    expect(gitUrl('/git/status', '/ws')).toBe('/git/status?cwd=%2Fws')
    expect(gitUrl('/git/log', '/ws', { skip: '0', limit: '20' })).toBe('/git/log?cwd=%2Fws&skip=0&limit=20')
  })
})

describe('gitGet', () => {
  it('returns the parsed payload', async () => {
    stubFetch(jsonResponse(200, { isRepo: true }))
    await expect(gitGet('/git/status', '/ws')).resolves.toEqual({ isRepo: true })
  })

  it('throws the body error text, or the HTTP status when absent', async () => {
    stubFetch(jsonResponse(500, { error: 'git failed' }))
    await expect(gitGet('/git/status', '/ws')).rejects.toThrow('git failed')
    stubFetch(jsonResponse(502, {}))
    await expect(gitGet('/git/status', '/ws')).rejects.toThrow('git panel: HTTP 502')
    stubFetch(brokenResponse(503))
    await expect(gitGet('/git/status', '/ws')).rejects.toThrow('git panel: HTTP 503')
  })
})

describe('gitPost', () => {
  it('posts the merged JSON body and returns the payload', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { ok: true }))
    await expect(gitPost('/git/stage', '/ws', { paths: ['a.ts'] })).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('/git/stage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['a.ts'], cwd: '/ws' }),
    })
  })

  it('throws the body error text, or the HTTP status when absent', async () => {
    stubFetch(jsonResponse(400, { error: 'bad path' }))
    await expect(gitPost('/git/stage', '/ws')).rejects.toThrow('bad path')
    stubFetch(jsonResponse(500, {}))
    await expect(gitPost('/git/stage', '/ws')).rejects.toThrow('git panel: HTTP 500')
    stubFetch(brokenResponse(503))
    await expect(gitPost('/git/stage', '/ws')).rejects.toThrow('git panel: HTTP 503')
  })
})

describe('gitGenerate', () => {
  it('streams text deltas and returns the full message on done', async () => {
    stubFetch(streamResponse(['{"t":"text","x":"feat: "}\n', '{"t":"text","x":"add"}\n{"t":"done","m":"feat: add"}\n']))
    const deltas: string[] = []
    await expect(gitGenerate('/ws', 'tok', delta => deltas.push(delta), 'model-a')).resolves.toBe('feat: add')
    expect(deltas).toEqual(['feat: ', 'add'])
  })

  it('returns the collected text when done carries no message, or when stopped', async () => {
    stubFetch(streamResponse(['{"t":"text","x":"part"}\n{"t":"done"}\n']))
    await expect(gitGenerate('/ws', 'tok', () => {})).resolves.toBe('part')
    stubFetch(streamResponse(['{"t":"text","x":"half"}\n{"t":"stop"}\n']))
    await expect(gitGenerate('/ws', 'tok', () => {})).resolves.toBe('half')
  })

  it('skips blank lines and reassembles a line split across chunks', async () => {
    stubFetch(streamResponse(['\n{"t":"te', 'xt","x":"a"}\n', '\n']))
    await expect(gitGenerate('/ws', 'tok', () => {})).rejects.toThrow(/closed without a result/)
  })

  it('ignores a text event without a string payload', async () => {
    stubFetch(streamResponse(['{"t":"text","x":5}\n{"t":"done","m":"ok"}\n']))
    await expect(gitGenerate('/ws', 'tok', () => {})).resolves.toBe('ok')
  })

  it('rejects on an err event with or without a message', async () => {
    stubFetch(streamResponse(['{"t":"err","e":"model offline"}\n']))
    await expect(gitGenerate('/ws', 'tok', () => {})).rejects.toThrow('model offline')
    stubFetch(streamResponse(['{"t":"err"}\n']))
    await expect(gitGenerate('/ws', 'tok', () => {})).rejects.toThrow(/generation failed/)
  })

  it('rejects when the stream closes without a result', async () => {
    stubFetch(streamResponse(['{"t":"text","x":"x"}\n']))
    await expect(gitGenerate('/ws', 'tok', () => {})).rejects.toThrow(/closed without a result/)
  })

  it('rejects a refused request with the body error text or HTTP status', async () => {
    stubFetch(jsonResponse(409, { error: 'no model' }))
    await expect(gitGenerate('/ws', 'tok', () => {})).rejects.toThrow('no model')
    stubFetch(jsonResponse(500, {}))
    await expect(gitGenerate('/ws', 'tok', () => {})).rejects.toThrow('git panel: HTTP 500')
    stubFetch({ ok: true, status: 200, body: null, json: async () => ({ error: 'no body' }) } as unknown as Response)
    await expect(gitGenerate('/ws', 'tok', () => {})).rejects.toThrow('no body')
    stubFetch(brokenResponse(500))
    await expect(gitGenerate('/ws', 'tok', () => {})).rejects.toThrow('git panel: HTTP 500')
  })
})

describe('gitApi', () => {
  const CASES: { name: string; run: () => Promise<unknown>; url: string; method: string; body?: unknown }[] = [
    { name: 'repos', run: () => gitApi.repos('/ws', true), url: '/git/repos?cwd=%2Fws&refresh=1', method: 'GET' },
    { name: 'repos without refresh', run: () => gitApi.repos('/ws', false), url: '/git/repos?cwd=%2Fws', method: 'GET' },
    { name: 'status', run: () => gitApi.status('/ws'), url: '/git/status?cwd=%2Fws', method: 'GET' },
    { name: 'log', run: () => gitApi.log('/ws', 20, 40), url: '/git/log?cwd=%2Fws&skip=20&limit=40&stat=1', method: 'GET' },
    { name: 'branches', run: () => gitApi.branches('/ws'), url: '/git/branches?cwd=%2Fws', method: 'GET' },
    { name: 'show', run: () => gitApi.show('/ws', 'abc'), url: '/git/show?cwd=%2Fws&hash=abc', method: 'GET' },
    { name: 'blob', run: () => gitApi.blob('/ws', 'a.png', 'head'), url: '/git/blob?cwd=%2Fws&path=a.png&source=head', method: 'GET' },
    { name: 'models', run: () => gitApi.models(), url: '/git/models?cwd=', method: 'GET' },
    { name: 'rules', run: () => gitApi.rules('/ws', 'repo'), url: '/git/rules?cwd=%2Fws&repo=repo', method: 'GET' },
    { name: 'stage', run: () => gitApi.stage('/ws', ['a']), url: '/git/stage', method: 'POST', body: { paths: ['a'], cwd: '/ws' } },
    { name: 'unstage', run: () => gitApi.unstage('/ws', ['a']), url: '/git/unstage', method: 'POST', body: { paths: ['a'], cwd: '/ws' } },
    { name: 'discard', run: () => gitApi.discard('/ws', ['a'], true), url: '/git/discard', method: 'POST', body: { paths: ['a'], staged: true, cwd: '/ws' } },
    { name: 'clean', run: () => gitApi.clean('/ws', ['a']), url: '/git/clean', method: 'POST', body: { paths: ['a'], cwd: '/ws' } },
    { name: 'diff', run: () => gitApi.diff('/ws', 'a', false, true), url: '/git/diff', method: 'POST', body: { path: 'a', staged: false, untracked: true, cwd: '/ws' } },
    { name: 'commit', run: () => gitApi.commit('/ws', 'msg'), url: '/git/commit', method: 'POST', body: { message: 'msg', cwd: '/ws' } },
    { name: 'undoCommit', run: () => gitApi.undoCommit('/ws', 'abc'), url: '/git/undo-commit', method: 'POST', body: { hash: 'abc', cwd: '/ws' } },
    { name: 'push', run: () => gitApi.push('/ws'), url: '/git/push', method: 'POST', body: { cwd: '/ws' } },
    { name: 'pull', run: () => gitApi.pull('/ws'), url: '/git/pull', method: 'POST', body: { cwd: '/ws' } },
    { name: 'switch', run: () => gitApi.switch('/ws', 'main', true), url: '/git/switch', method: 'POST', body: { branch: 'main', create: true, cwd: '/ws' } },
    { name: 'stashList', run: () => gitApi.stashList('/ws'), url: '/git/stash', method: 'POST', body: { op: 'list', cwd: '/ws' } },
    { name: 'stashPush', run: () => gitApi.stashPush('/ws', 'wip'), url: '/git/stash', method: 'POST', body: { op: 'push', message: 'wip', cwd: '/ws' } },
    { name: 'stashPush without message', run: () => gitApi.stashPush('/ws'), url: '/git/stash', method: 'POST', body: { op: 'push', cwd: '/ws' } },
    { name: 'stashPop', run: () => gitApi.stashPop('/ws'), url: '/git/stash', method: 'POST', body: { op: 'pop', cwd: '/ws' } },
    { name: 'mergeAbort', run: () => gitApi.mergeAbort('/ws'), url: '/git/merge-abort', method: 'POST', body: { cwd: '/ws' } },
    { name: 'mergeComplete', run: () => gitApi.mergeComplete('/ws'), url: '/git/merge-complete', method: 'POST', body: { cwd: '/ws' } },
    { name: 'reset', run: () => gitApi.reset('/ws', 'hard'), url: '/git/reset', method: 'POST', body: { mode: 'hard', cwd: '/ws' } },
    {
      name: 'rulesSave',
      run: () => gitApi.rulesSave('/ws', 'repo', 'repo', 'sys', 'user'),
      url: '/git/rules-save',
      method: 'POST',
      body: { repo: 'repo', scope: 'repo', systemPrompt: 'sys', userContext: 'user', cwd: '/ws' },
    },
    { name: 'rulesReset', run: () => gitApi.rulesReset('/ws', 'repo', 'global'), url: '/git/rules-reset', method: 'POST', body: { repo: 'repo', scope: 'global', cwd: '/ws' } },
    { name: 'generateCancel', run: () => gitApi.generateCancel('tok'), url: '/git/generate-cancel', method: 'POST', body: { token: 'tok', cwd: '' } },
  ]

  it.each(CASES)('$name requests $url', async ({ run, url, method, body }) => {
    const fetchMock = stubFetch(jsonResponse(200, { ok: true }))
    await run()
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(target).toBe(url)
    if (method === 'GET') {
      expect(init).toBeUndefined()
      return
    }
    expect(init?.method).toBe('POST')
    const sent = init?.body
    if (typeof sent !== 'string') throw new Error('expected a JSON string body')
    expect(JSON.parse(sent)).toEqual(body)
  })

  it('generate forwards to the NDJSON stream', async () => {
    stubFetch(streamResponse(['{"t":"done","m":"msg"}\n']))
    await expect(gitApi.generate('/ws', 'tok', () => {}, 'm1')).resolves.toBe('msg')
  })
})
