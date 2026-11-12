import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { buildTools } from '../src/index.ts'
import type { AuthSetting } from '../src/runtime.ts'

/** Minimal run context: the generated tools read only the caller signal. */
const EXEC: ToolRunContext = {
  callId: ToolCallId('openapi-tools'),
  rootCallId: ToolCallId('openapi-tools'),
  name: 'openapi',
  arguments: {},
  token: Symbol('openapi-tools') as ToolExecutionToken,
  signal: new AbortController().signal,
  deferContext() {},
  concludeTurn() {},
}

interface RecordedRequest {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

let server: Server
let baseUrl: string
let last: RecordedRequest | undefined

/** Document whose operations exercise every transport branch the plugin owns. */
function document(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Echo API', version: '1.0.0' },
    paths: {
      '/items/{id}': {
        get: {
          operationId: 'getItem',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'tags', in: 'query', style: 'form', explode: true, schema: { type: 'array', items: { type: 'string' } } },
            {
              name: 'filter',
              in: 'query',
              style: 'deepObject',
              explode: true,
              schema: { type: 'object', additionalProperties: false, properties: { color: { type: 'string' } } },
            },
            { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/items': {
        post: {
          operationId: 'createItem',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name'],
                  properties: { name: { type: 'string' } },
                },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
      '/text': { get: { operationId: 'getText', responses: { '200': { description: 'ok' } } } },
      '/empty': { get: { operationId: 'getEmpty', responses: { '204': { description: 'empty' } } } },
      '/broken': { get: { operationId: 'getBroken', responses: { '200': { description: 'ok' } } } },
      '/missing': { get: { operationId: 'getMissing', responses: { '200': { description: 'ok' } } } },
    },
  }
}

function toolNamed(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`missing generated tool ${name}`)
  return tool
}

beforeEach(async () => {
  last = undefined
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      last = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() }
      const path = request.url?.split('?')[0] ?? ''
      if (path === '/items' && request.method === 'POST') {
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ received: JSON.parse(last.body) as unknown }))
        return
      }
      if (path.startsWith('/items/')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ path: request.url }))
        return
      }
      if (path === '/text') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('x'.repeat(50))
        return
      }
      if (path === '/empty') {
        response.writeHead(204)
        response.end()
        return
      }
      if (path === '/broken') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('not json')
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'no such item' }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
})

describe('generated tool execution', () => {
  it('serializes path, query, header, static header, and bearer auth', async () => {
    const { tools } = buildTools(document(), {
      baseUrl,
      headers: { 'x-static': 'yes' },
      auth: { scheme: 'bearer', resolve: async () => 'secret' },
    })
    const result = await toolNamed(tools, 'getItem').execute(
      { id: 'a/b', tags: ['one', 'two'], filter: { color: 'red' }, 'X-Trace': 'trace-1' },
      EXEC,
    )
    expect(result).toEqual({ path: '/items/a%2Fb?tags=one&tags=two&filter%5Bcolor%5D=red' })
    expect(last?.headers['x-static']).toBe('yes')
    expect(last?.headers.authorization).toBe('Bearer secret')
    expect(last?.headers['x-trace']).toBe('trace-1')
  })

  it('sends a JSON body with its declared media type', async () => {
    const { tools } = buildTools(document(), { baseUrl })
    const result = await toolNamed(tools, 'createItem').execute({ body: { name: 'Ada' } }, EXEC)
    expect(result).toEqual({ received: { name: 'Ada' } })
    expect(last?.method).toBe('POST')
    expect(last?.headers['content-type']).toBe('application/json')
    expect(last?.body).toBe('{"name":"Ada"}')
  })

  it('reports an HTTP failure with status and body', async () => {
    const { tools } = buildTools(document(), { baseUrl })
    await expect(toolNamed(tools, 'getMissing').execute({}, EXEC))
      .rejects.toThrow(/HTTP 404: .*no such item/)
  })

  it('truncates a non-JSON body', async () => {
    const { tools } = buildTools(document(), { baseUrl, maxResponseChars: 10 })
    await expect(toolNamed(tools, 'getText').execute({}, EXEC)).resolves.toBe('xxxxxxxxx…')
  })

  it('returns null for an empty body', async () => {
    const { tools } = buildTools(document(), { baseUrl })
    await expect(toolNamed(tools, 'getEmpty').execute({}, EXEC)).resolves.toBeNull()
  })

  it('rejects malformed JSON', async () => {
    const { tools } = buildTools(document(), { baseUrl })
    await expect(toolNamed(tools, 'getBroken').execute({}, EXEC))
      .rejects.toMatchObject({ code: 'OPENAPI_RESPONSE_INVALID' })
  })

  it('fails before sending when the credential is unavailable', async () => {
    const { tools } = buildTools(document(), { baseUrl, auth: { scheme: 'bearer', resolve: async () => undefined } })
    await expect(toolNamed(tools, 'getItem').execute({ id: 'a' }, EXEC)).rejects.toMatchObject({
      code: 'OPENAPI_CREDENTIAL_MISSING',
    })
    expect(last).toBeUndefined()
  })

  it('sends a query credential in the configured parameter', async () => {
    const { tools } = buildTools(document(), {
      baseUrl,
      auth: { scheme: 'query', name: 'api_key', resolve: async () => 'k-1' },
    })
    await toolNamed(tools, 'getItem').execute({ id: 'a' }, EXEC)
    expect(last?.url).toContain('api_key=k-1')
  })

  it('rejects a header credential without a parameter name', async () => {
    const auth: AuthSetting = { scheme: 'header', resolve: async () => 'k-1' }
    const { tools } = buildTools(document(), { baseUrl, auth })
    await expect(toolNamed(tools, 'getItem').execute({ id: 'a' }, EXEC)).rejects.toMatchObject({
      code: 'OPENAPI_AUTH_INVALID',
    })
  })
})
