import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCassetteFetch, type Cassette, type CassetteInteraction } from '../src/index.ts'

interface CapturedRequest {
  readonly method: string
  readonly url: string
  readonly body: string
}

interface LocalServer {
  readonly baseUrl: string
  readonly requests: readonly CapturedRequest[]
  /** Close the listener; repeated calls are no-ops so teardown and inline closes coexist. */
  readonly close: () => Promise<void>
}

const servers: LocalServer[] = []
const originalCi = process.env.CI
let dir: string

beforeEach(() => {
  const root = join(process.cwd(), 'tmp')
  mkdirSync(root, { recursive: true })
  dir = mkdtempSync(join(root, 'http-cassette-test-'))
  // Recording tests must run locally even when the suite itself runs in CI.
  delete process.env.CI
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  rmSync(dir, { recursive: true, force: true })
  if (originalCi === undefined) delete process.env.CI
  else process.env.CI = originalCi
})

/**
 * Start a real loopback HTTP server.
 * @param handler - Responds to each request after its body is buffered.
 * @returns Base URL, captured requests, and an idempotent close.
 */
async function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<LocalServer> {
  const requests: CapturedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      })
      handler(request, response)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP address')
  let closed = false
  const local: LocalServer = {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    },
  }
  servers.push(local)
  return local
}

/**
 * Read one cassette file from the per-test directory.
 * @param name - Cassette name without `.json`.
 * @returns The decoded cassette.
 */
function readCassetteFile(name: string): Cassette {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Cassette
}

/**
 * Read the only interaction a single-request test recorded.
 * @param name - Cassette name without `.json`.
 * @returns The first recorded interaction.
 */
function firstInteraction(name: string): CassetteInteraction {
  const interaction = readCassetteFile(name).interactions[0]
  if (interaction === undefined) throw new Error(`cassette ${name} recorded no interaction`)
  return interaction
}

describe('http-cassette', () => {
  it('records a real response and replays it after the server is gone', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'x-mock': 'yes' })
      response.end(JSON.stringify({ ok: true, value: 41 }))
    })
    const url = `${server.baseUrl}/items?page=2`
    const recorder = createCassetteFetch({ mode: 'record', dir, name: 'basic' })

    const recorded = await recorder(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local-secret-value' },
      body: JSON.stringify({ b: 2, a: 1 }),
    })
    expect(await recorded.json()).toEqual({ ok: true, value: 41 })
    expect(server.requests).toHaveLength(1)
    recorder.assertComplete()

    const cassette = readCassetteFile('basic')
    expect(cassette.version).toBe(1)
    expect(cassette.name).toBe('basic')
    expect(cassette.interactions).toHaveLength(1)
    const interaction = firstInteraction('basic')
    expect(interaction.request.method).toBe('POST')
    expect(interaction.request.url).toBe(url)
    expect(interaction.request.body).toBe(JSON.stringify({ b: 2, a: 1 }))
    expect(interaction.request.headers).not.toHaveProperty('authorization')
    expect(interaction.response.status).toBe(200)
    expect(interaction.response.body).toBe(JSON.stringify({ ok: true, value: 41 }))

    await server.close()
    const replay = createCassetteFetch({ mode: 'replay', dir, name: 'basic' })
    const replayed = await replay(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1, b: 2 }),
    })
    expect(replayed.status).toBe(200)
    expect(replayed.headers.get('x-mock')).toBe('yes')
    expect(await replayed.json()).toEqual({ ok: true, value: 41 })
    replay.assertComplete()
  })

  it('auto mode records a missing cassette and replays it afterwards', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('auto')
    })
    const url = `${server.baseUrl}/auto`

    const first = createCassetteFetch({ mode: 'auto', dir, name: 'auto' })
    expect(await (await first(url)).text()).toBe('auto')
    expect(existsSync(join(dir, 'auto.json'))).toBe(true)
    await server.close()

    const second = createCassetteFetch({ mode: 'auto', dir, name: 'auto' })
    expect(await (await second(url)).text()).toBe('auto')
    second.assertComplete()
  })

  it('consumes identical requests in cassette order to model retries', async () => {
    let attempts = 0
    const server = await startServer((_request, response) => {
      attempts += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ attempt: attempts }))
    })
    const url = `${server.baseUrl}/retry`
    const recorder = createCassetteFetch({ mode: 'record', dir, name: 'ordered' })
    for (let attempt = 0; attempt < 3; attempt += 1) await recorder(url)
    await server.close()

    expect(readCassetteFile('ordered').interactions).toHaveLength(3)
    const replay = createCassetteFetch({ mode: 'replay', dir, name: 'ordered' })
    const bodies: unknown[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) bodies.push(await (await replay(url)).json())
    expect(bodies).toEqual([{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }])
    replay.assertComplete()
  })

  it('fails a replay request that no unconsumed entry matches', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('a')
    })
    const recorder = createCassetteFetch({ mode: 'record', dir, name: 'missing' })
    await recorder(`${server.baseUrl}/a`)
    await server.close()

    const replay = createCassetteFetch({ mode: 'replay', dir, name: 'missing' })
    await expect(replay(`${server.baseUrl}/b`)).rejects.toThrow(/no unconsumed entry .* GET .*\/b/)
  })

  it('reports unconsumed entries from assertComplete and dispose', async () => {
    const server = await startServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(request.url ?? '')
    })
    const recorder = createCassetteFetch({ mode: 'record', dir, name: 'incomplete' })
    await recorder(`${server.baseUrl}/first`)
    await recorder(`${server.baseUrl}/second`)
    await server.close()

    const replay = createCassetteFetch({ mode: 'replay', dir, name: 'incomplete' })
    await replay(`${server.baseUrl}/first`)
    expect(() => {
      replay.assertComplete()
    }).toThrow(/1 of 2 interaction\(s\) in "incomplete" were never consumed/)
    expect(() => {
      replay.dispose()
    }).toThrow(/were never consumed/)

    await replay(`${server.baseUrl}/second`)
    expect(() => {
      replay.dispose()
    }).not.toThrow()
  })

  it('drops credential headers and redacts sensitive query parameters', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'session=abc' })
      response.end('ok')
    })
    const recorder = createCassetteFetch({ mode: 'record', dir, name: 'redacted' })
    await recorder(`${server.baseUrl}/search?token=alpha&key=beta&secret=gamma&page=2`, {
      headers: {
        authorization: 'Bearer header-secret',
        cookie: 'sid=1',
        'x-api-key': 'header-key',
        accept: 'text/plain',
      },
    })

    const interaction = firstInteraction('redacted')
    expect(interaction.request.headers).not.toHaveProperty('authorization')
    expect(interaction.request.headers).not.toHaveProperty('cookie')
    expect(interaction.request.headers).not.toHaveProperty('x-api-key')
    expect(interaction.request.headers.accept).toBe('text/plain')
    expect(interaction.request.url).toContain('token=%5BREDACTED%5D')
    expect(interaction.request.url).toContain('key=%5BREDACTED%5D')
    expect(interaction.request.url).toContain('secret=%5BREDACTED%5D')
    expect(interaction.request.url).toContain('page=2')
    expect(interaction.request.url).not.toContain('alpha')
    expect(interaction.response.headers).not.toHaveProperty('set-cookie')
  })

  it('refuses a credential in the request body unless scrub is requested', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx'
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
    const url = `${server.baseUrl}/chat`

    const rejecting = createCassetteFetch({ mode: 'record', dir, name: 'leaky-request' })
    await expect(
      rejecting(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: secret }),
      }),
    ).rejects.toThrow(/possible credentials \(API key\)/)
    expect(existsSync(join(dir, 'leaky-request.json'))).toBe(false)

    const scrubbing = createCassetteFetch({ mode: 'record', dir, name: 'scrubbed-request', redact: 'scrub' })
    await scrubbing(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: secret }),
    })
    expect(firstInteraction('scrubbed-request').request.body).not.toContain(secret)
    expect(firstInteraction('scrubbed-request').request.body).toContain('[REDACTED]')
  })

  it('scrubs a credential found in a response body', async () => {
    const secret = 'Bearer abcdefghijklmnopqrstuvwxyz'
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ echo: secret }))
    })
    const recorder = createCassetteFetch({ mode: 'record', dir, name: 'leaky-response', redact: 'scrub' })
    await recorder(`${server.baseUrl}/echo`)

    const stored = firstInteraction('leaky-response').response.body
    expect(stored).not.toContain(secret)
    expect(stored).toContain('[REDACTED]')
  })

  it('refuses to record while CI is set', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ci')
    })
    const recorder = createCassetteFetch({ mode: 'record', dir, name: 'ci-source' })
    await recorder(`${server.baseUrl}/ci`)
    await server.close()

    process.env.CI = 'true'
    try {
      expect(() => createCassetteFetch({ mode: 'record', dir, name: 'ci-blocked' })).toThrow(/while CI is set/)
      expect(() => createCassetteFetch({ mode: 'auto', dir, name: 'ci-missing' })).toThrow(/while CI is set/)
      const replay = createCassetteFetch({ mode: 'auto', dir, name: 'ci-source' })
      expect((await replay(`${server.baseUrl}/ci`)).status).toBe(200)
      replay.assertComplete()
    } finally {
      delete process.env.CI
    }
  })

  it('records a binary response as base64 and replays the exact bytes', async () => {
    const bytes = Uint8Array.from([0, 255, 1, 254, 2, 128])
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.from(bytes))
    })
    const url = `${server.baseUrl}/blob`
    const recorder = createCassetteFetch({ mode: 'record', dir, name: 'binary' })
    const recorded = await recorder(url)
    expect(new Uint8Array(await recorded.arrayBuffer())).toEqual(bytes)

    const interaction = firstInteraction('binary')
    expect(interaction.response.bodyEncoding).toBe('base64')
    expect(interaction.response.body).toBe(Buffer.from(bytes).toString('base64'))

    await server.close()
    const replay = createCassetteFetch({ mode: 'replay', dir, name: 'binary' })
    expect(new Uint8Array(await (await replay(url)).arrayBuffer())).toEqual(bytes)
  })

  it('rejects a cassette name that escapes the recording directory', () => {
    expect(() => createCassetteFetch({ mode: 'replay', dir, name: '../escape' })).toThrow(/invalid cassette name/)
    expect(() => createCassetteFetch({ mode: 'replay', dir, name: '..\\escape' })).toThrow(/invalid cassette name/)
    expect(() => createCassetteFetch({ mode: 'replay', dir, name: '' })).toThrow(/invalid cassette name/)
    expect(() => createCassetteFetch({ mode: 'replay', dir, name: join(dir, 'absolute') })).toThrow(/invalid cassette name/)
  })

  it('fails when replay names a cassette that was never recorded', () => {
    expect(() => createCassetteFetch({ mode: 'replay', dir, name: 'absent' })).toThrow(/not found at/)
  })

  it('rejects malformed cassette files with the field that failed validation', () => {
    const request = { method: 'GET', url: 'http://127.0.0.1:1/x', headers: {}, body: '', bodyEncoding: 'text' }
    const response = { status: 200, statusText: 'OK', headers: {}, body: 'ok', bodyEncoding: 'text' }
    const cassette = (interaction: unknown): unknown => ({
      version: 1,
      name: 'manual',
      recordedAt: 'now',
      interactions: [interaction],
    })
    const documents: { contents: string; expected: RegExp }[] = [
      { contents: '{not-json', expected: /is invalid: SyntaxError/ },
      { contents: JSON.stringify([]), expected: /top level is not an object/ },
      { contents: JSON.stringify({ version: 2, name: 'manual', recordedAt: 'now', interactions: [] }), expected: /version must be 1/ },
      { contents: JSON.stringify({ version: 1, name: 7, recordedAt: 'now', interactions: [] }), expected: /name must be a string/ },
      { contents: JSON.stringify({ version: 1, name: 'manual', recordedAt: 7, interactions: [] }), expected: /recordedAt must be a string/ },
      { contents: JSON.stringify({ version: 1, name: 'manual', recordedAt: 'now', interactions: 'none' }), expected: /interactions must be an array/ },
      { contents: JSON.stringify(cassette('none')), expected: /interactions\[0\] is not an object/ },
      { contents: JSON.stringify(cassette({ response })), expected: /interactions\[0\]\.request is not an object/ },
      { contents: JSON.stringify(cassette({ request })), expected: /interactions\[0\]\.response is not an object/ },
    ]
    const fields: readonly { readonly request?: unknown; readonly response?: unknown; readonly expected: RegExp }[] = [
      { request: { ...request, method: 7 }, expected: /request\.method must be a string/ },
      { request: { ...request, url: 7 }, expected: /request\.url must be a string/ },
      { request: { ...request, headers: [] }, expected: /request\.headers must be an object/ },
      { request: { ...request, headers: { accept: 7 } }, expected: /request\.headers\.accept must be a string/ },
      { request: { ...request, body: 7 }, expected: /request\.body must be a string/ },
      { request: { ...request, bodyEncoding: 'binary' }, expected: /request\.bodyEncoding must be "text" or "base64"/ },
      { response: { ...response, status: 'ok' }, expected: /response\.status must be a number/ },
      { response: { ...response, statusText: 7 }, expected: /response\.statusText must be a string/ },
      { response: { ...response, headers: [] }, expected: /response\.headers must be an object/ },
      { response: { ...response, headers: { age: 7 } }, expected: /response\.headers\.age must be a string/ },
      { response: { ...response, body: 7 }, expected: /response\.body must be a string/ },
      { response: { ...response, bodyEncoding: 'binary' }, expected: /response\.bodyEncoding must be "text" or "base64"/ },
    ]
    for (const field of fields) {
      documents.push({
        contents: JSON.stringify(cassette({ request: field.request ?? request, response: field.response ?? response })),
        expected: field.expected,
      })
    }
    documents.forEach((document, index) => {
      const name = `malformed-${String(index)}`
      writeFileSync(join(dir, `${name}.json`), document.contents, 'utf8')
      expect(() => createCassetteFetch({ mode: 'replay', dir, name }), document.contents).toThrow(document.expected)
    })
  })

  it('reports an unreadable cassette path as invalid', () => {
    mkdirSync(join(dir, 'as-directory.json'))
    expect(() => createCassetteFetch({ mode: 'replay', dir, name: 'as-directory' })).toThrow(/is invalid: Error: EISDIR/)
  })

  it('records a binary request body as base64 and matches identical bytes', async () => {
    const payload = Uint8Array.from([0, 255, 7])
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
    const url = `${server.baseUrl}/upload`
    const recorder = createCassetteFetch({ mode: 'record', dir, name: 'binary-request' })
    await recorder(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload })

    const interaction = firstInteraction('binary-request')
    expect(interaction.request.bodyEncoding).toBe('base64')
    expect(interaction.request.body).toBe(Buffer.from(payload).toString('base64'))

    const replay = createCassetteFetch({ mode: 'replay', dir, name: 'binary-request' })
    await expect(
      replay(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Uint8Array.from([0, 255, 8]),
      }),
    ).rejects.toThrow(/no unconsumed entry/)
    expect(
      (await replay(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload })).status,
    ).toBe(200)
  })

  it('matches non-JSON text bodies verbatim', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('plain')
    })
    const url = `${server.baseUrl}/text`
    const recorder = createCassetteFetch({ mode: 'record', dir, name: 'text-body' })
    await recorder(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'plain payload' })
    await server.close()

    const replay = createCassetteFetch({ mode: 'replay', dir, name: 'text-body' })
    await expect(replay(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'other payload' })).rejects.toThrow(/no unconsumed entry/)
    expect((await replay(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'plain payload' })).status).toBe(200)
  })

  it('normalizes array elements inside a JSON request body', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
    const url = `${server.baseUrl}/batch`
    const recorder = createCassetteFetch({ mode: 'record', dir, name: 'json-array' })
    await recorder(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[{"b":2,"a":1}]',
    })
    await server.close()

    const replay = createCassetteFetch({ mode: 'replay', dir, name: 'json-array' })
    expect(
      (await replay(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[{"a":1,"b":2}]' })).status,
    ).toBe(200)
  })

  it('replays a bodyless status and a response without a content type', async () => {
    let call = 0
    const server = await startServer((_request, response) => {
      call += 1
      if (call === 1) {
        response.writeHead(204)
        response.end()
        return
      }
      response.writeHead(200)
      response.end('raw')
    })
    const url = `${server.baseUrl}/status`

    const recorder = createCassetteFetch({ mode: 'record', dir, name: 'statuses' })
    expect((await recorder(`${url}/no-content`)).status).toBe(204)
    expect(await (await recorder(`${url}/raw`)).text()).toBe('raw')
    await server.close()

    const interactions = readCassetteFile('statuses').interactions
    expect(interactions[0]?.response.body).toBe('')
    expect(interactions[1]?.response.bodyEncoding).toBe('text')

    const replay = createCassetteFetch({ mode: 'replay', dir, name: 'statuses' })
    const noContent = await replay(`${url}/no-content`)
    expect(noContent.status).toBe(204)
    expect(await noContent.text()).toBe('')
    expect(await (await replay(`${url}/raw`)).text()).toBe('raw')
    replay.assertComplete()
  })

  it('treats CI values of false and 0 as local runs', () => {
    for (const value of ['', 'false', '0']) {
      process.env.CI = value
      try {
        expect(() => createCassetteFetch({ mode: 'record', dir, name: `ci-${value || 'empty'}` })).not.toThrow()
      } finally {
        delete process.env.CI
      }
    }
  })
})
