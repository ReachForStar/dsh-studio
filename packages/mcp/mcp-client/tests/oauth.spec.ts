/** OAuth against a local authorization server: discovery, registration, PKCE, exchange, refresh. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { expect, it, onTestFinished, vi } from 'vitest'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord, CredentialRecordEntry, CredentialRecordInfo } from '@deepseek-ai/dsh-credentials'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { resolveReconnectPolicy, startConnection } from '../src/connection.ts'
import type { StreamableHttpConfig } from '../src/index.ts'
import { authorizationKey, beginAuthorization, clearAuthorization, createOAuthProvider, hasStoredTokens } from '../src/oauth.ts'
import { McpStatusCell } from '../src/status.ts'

/** In-memory credential records, the shape an OAuth grant is stored in. */
class MemoryCredentials extends CredentialProvider {
  readonly records = new Map<string, CredentialRecord>()
  resolve(): Promise<undefined> { return Promise.resolve(undefined) }
  describe(): Promise<never> { throw new Error('unexpected reference read') }
  set(): Promise<never> { throw new Error('unexpected reference write') }
  unset(): Promise<never> { throw new Error('unexpected reference removal') }
  readRecord(key: string): Promise<CredentialRecord | undefined> { return Promise.resolve(this.records.get(key)) }
  describeRecord(key: string): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return Promise.resolve({
      configured: record !== undefined,
      ...record === undefined ? {} : { kind: record.kind },
      writable: true,
    })
  }
  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key: key as CredentialRecordEntry['key'], kind: record.kind })))
  }
  async modifyRecord(
    key: string,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next !== undefined) this.records.set(key, next)
    return next
  }
  async deleteRecord(key: string): Promise<void> { this.records.delete(key) }
}

/** Local authorization server plus the MCP endpoint it protects. */
interface AuthorizationFixture {
  url: string
  /** Access token the MCP endpoint accepts right now. */
  accept(token: string): void
  /** Make the next access token expire, so a request must refresh. */
  expire(): void
  /** Token requests seen, by grant type. */
  readonly grants: string[]
  /** Client registrations seen. */
  readonly registrations: number
  /** Delay each token response, so a test can observe concurrent callbacks. */
  setTokenDelay(ms: number): void
  close: () => Promise<void>
}

/**
 * Start a protected MCP endpoint whose authorization server supports
 * discovery, dynamic registration, PKCE, the code exchange, and refresh.
 */
async function startAuthorizationFixture(): Promise<AuthorizationFixture> {
  let access = ''
  let refresh = 'refresh-1'
  let issued = 0
  let tokenDelayMs = 0
  const grants: string[] = []
  let registrations = 0
  const codes = new Map<string, { challenge: string; redirect: string }>()
  const mcp = createMcpHandler(() => {
    const server = new McpServer({ name: 'guarded', version: '1' }, { capabilities: { tools: {} } })
    server.registerTool('ping', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    return server
  })
  const handleMcp = toNodeHandler(mcp)
  const server: Server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => { response.writeHead(500).end(String(error)) })
  })
  const origin = async (): Promise<string> => {
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('authorization fixture has no address')
    return `http://127.0.0.1:${String(address.port)}`
  }
  const base = await origin()
  const metadata = {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', base)
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }))
      return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(metadata))
      return
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      registrations++
      // RFC 7591 responses repeat the registered metadata with a client id.
      const submitted = JSON.parse(await text(request)) as Record<string, unknown>
      response.writeHead(201, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ...submitted, client_id: `client-${String(registrations)}` }))
      return
    }
    if (url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri') ?? ''
      const state = url.searchParams.get('state') ?? ''
      const challenge = url.searchParams.get('code_challenge') ?? ''
      const code = `code-${String(codes.size + 1)}`
      codes.set(code, { challenge, redirect })
      response.writeHead(302, { location: `${redirect}?code=${code}&state=${encodeURIComponent(state)}` }).end()
      return
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const body = new URLSearchParams(await text(request))
      if (tokenDelayMs > 0) await new Promise<void>((resolve) => { setTimeout(resolve, tokenDelayMs) })
      const grant = body.get('grant_type') ?? ''
      grants.push(grant)
      if (grant === 'authorization_code' && !codes.has(body.get('code') ?? '')) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }))
        return
      }
      if (grant === 'refresh_token' && body.get('refresh_token') !== refresh) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }))
        return
      }
      access = `access-${String(++issued)}`
      refresh = `refresh-${String(issued)}`
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ access_token: access, token_type: 'Bearer', expires_in: 3_600, refresh_token: refresh }))
      return
    }
    if (url.pathname === '/mcp') {
      if (request.headers.authorization !== `Bearer ${access}`) {
        response.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        }).end()
        return
      }
      await handleMcp(request as NodeIncomingMessageLike, response)
      return
    }
    response.writeHead(404).end()
  }

  return {
    url: `${base}/mcp`,
    accept: (token) => { access = token },
    expire: () => { access = 'expired' },
    grants,
    get registrations() { return registrations },
    setTokenDelay: (ms) => { tokenDelayMs = ms },
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

/** Read a request body as text. */
function text(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    request.on('error', reject)
  })
}

/** Mount the tool registry and an in-memory credentials provider. */
async function mountContext(): Promise<{ ctx: Context; credentials: MemoryCredentials }> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(MemoryCredentials)
  return { ctx, credentials: ctx.credentials as MemoryCredentials }
}

/** OAuth-configured remote server pointing at the fixture. */
function oauthConfig(url: string): StreamableHttpConfig {
  return {
    transport: 'streamable-http', serverName: 'guarded', url, headers: {},
    toolCallTimeoutMs: 15_000, resourceWatchTimeoutMs: 30_000, maxResourceWatchTimeoutMs: 300_000,
    startupTimeoutMs: 30_000, closeTimeoutMs: 5_000,
    expandTemplates: false, failOnStartupError: false,
    oauth: { scope: 'mcp.read' },
  }
}

/** Drive the browser: follow the authorization redirect into the loopback callback. */
async function driveBrowser(url: string): Promise<void> {
  const authorize = await fetch(url, { redirect: 'manual' })
  const location = authorize.headers.get('location')
  if (location === null) throw new Error('the authorization server did not redirect')
  const callback = await fetch(location)
  if (!callback.ok) throw new Error(`the callback refused the grant: ${String(callback.status)}`)
}

it('authorizes against discovery, dynamic registration, and PKCE, then connects', async () => {
  const fixture = await startAuthorizationFixture()
  onTestFinished(fixture.close)
  const { ctx, credentials } = await mountContext()
  const config = oauthConfig(fixture.url)
  const flow = await beginAuthorization(ctx, config, new AbortController().signal)
  expect(flow.url).toContain('/authorize')
  await driveBrowser(flow.url ?? '')
  await flow.completed

  const record = credentials.records.get(authorizationKey(config.url))
  expect(record?.kind).toBe('grant')
  const stored = z.object({ tokens: z.object({ access_token: z.string() }).optional() })
    .parse(record?.kind === 'grant' ? record.payload : undefined)
  expect(stored.tokens?.access_token).toBe('access-1')
  expect(fixture.registrations).toBe(1)

  fixture.accept('access-1')
  const connection = startConnection(ctx, config, resolveReconnectPolicy({ enabled: false }, 'fixture'), new McpStatusCell(() => {}))
  onTestFinished(() => connection.dispose())
  await connection.ready
  expect(ctx.tools.get('mcp__guarded__ping')).toBeDefined()
}, 30_000)

it('refreshes an expired access token without another interactive flow', async () => {
  const fixture = await startAuthorizationFixture()
  onTestFinished(fixture.close)
  const { ctx } = await mountContext()
  const config = oauthConfig(fixture.url)
  const flow = await beginAuthorization(ctx, config, new AbortController().signal)
  await driveBrowser(flow.url ?? '')
  await flow.completed

  fixture.accept('access-1')
  const connection = startConnection(ctx, config, resolveReconnectPolicy({ enabled: false }, 'fixture'), new McpStatusCell(() => {}))
  onTestFinished(() => connection.dispose())
  await connection.ready

  // The server stops accepting the presented token; the transport refreshes it.
  fixture.expire()
  expect(ctx.tools.get('mcp__guarded__ping')).toBeDefined()
  await expect(executePing(ctx)).resolves.toBe('pong')
  expect(fixture.grants).toContain('refresh_token')
}, 30_000)

it('reports waiting-authorization instead of retrying when no grant is stored', async () => {
  const fixture = await startAuthorizationFixture()
  onTestFinished(fixture.close)
  const { ctx } = await mountContext()
  const status = new McpStatusCell(() => {})
  const connection = startConnection(ctx, oauthConfig(fixture.url), resolveReconnectPolicy(undefined, 'fixture'), status)
  onTestFinished(() => connection.dispose())
  await connection.ready
  await vi.waitFor(() => { expect(status.current()).toMatchObject({ state: 'waiting-authorization' }) })
}, 30_000)

it('rejects a callback whose state does not match', async () => {
  const fixture = await startAuthorizationFixture()
  onTestFinished(fixture.close)
  const { ctx, credentials } = await mountContext()
  const config = oauthConfig(fixture.url)
  const flow = await beginAuthorization(ctx, config, new AbortController().signal)
  const redirect = new URL(flow.url ?? '')
  const state = redirect.searchParams.get('state') ?? ''
  const callback = new URL(redirect.searchParams.get('redirect_uri') ?? '')
  callback.searchParams.set('code', 'code-1')
  callback.searchParams.set('state', `${state}-tampered`)
  const response = await fetch(callback)
  expect(response.status).toBe(400)
  await expect(flow.completed).rejects.toThrow(/state mismatch/)
  const record = credentials.records.get(authorizationKey(config.url))
  const stored = z.object({ tokens: z.unknown().optional() }).parse(record?.kind === 'grant' ? record.payload : undefined)
  expect(stored.tokens).toBeUndefined()
}, 30_000)

/** Execute the guarded ping tool through the native executor. */
async function executePing(ctx: Context): Promise<string> {
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('oauth-call'),
    name: 'mcp__guarded__ping',
    arguments: {},
  })
  const block = result.content[0]
  return block?.type === 'text' ? block.text : ''
}

it('refuses OAuth configuration without a credentials provider', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  expect(() => startConnection(ctx, oauthConfig('http://127.0.0.1:1/mcp'), resolveReconnectPolicy(undefined, 'fixture'), new McpStatusCell(() => {})))
    .toThrow(/OAuth requires a credentials provider/)
})

it('rejects a flow for a server without OAuth settings', async () => {
  const { ctx } = await mountContext()
  const { oauth: _oauth, ...config } = oauthConfig('http://127.0.0.1:1/mcp')
  await expect(beginAuthorization(ctx, config, new AbortController().signal)).rejects.toThrow(/OAuth is not configured for this server/)
})

it('exposes the provider contract the SDK drives', async () => {
  const { ctx, credentials } = await mountContext()
  const config = oauthConfig('http://127.0.0.1:1/mcp')
  const provider = createOAuthProvider(ctx, config, { redirectUri: 'http://127.0.0.1:9/callback' })
  expect(provider.clientMetadata).toMatchObject({
    redirect_uris: ['http://127.0.0.1:9/callback'],
    token_endpoint_auth_method: 'none',
    scope: 'mcp.read',
  })
  expect(await provider.clientInformation?.()).toBeUndefined()
  await provider.saveTokens?.({ access_token: 'a', token_type: 'Bearer', refresh_token: 'r' })
  expect(await provider.tokens?.()).toMatchObject({ access_token: 'a' })
  await expect(provider.codeVerifier?.()).rejects.toThrow(/PKCE verifier/)
  const state = await provider.state?.()
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(await provider.state?.()).not.toBe(state)
  expect(() => { void provider.redirectToAuthorization?.(new URL('http://127.0.0.1/authorize')) })
    .toThrow(/needs user authorization/)
  expect(credentials.records.size).toBe(1)
})

it('uses a pre-registered confidential client when configured', async () => {
  const { ctx } = await mountContext()
  const provider = createOAuthProvider(ctx, { ...oauthConfig('http://127.0.0.1:1/mcp'), oauth: { clientId: 'client-9', clientSecret: 'shh' } })
  expect(provider.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post')
  expect(provider.clientMetadata.scope).toBeUndefined()
  expect(await provider.clientInformation?.()).toEqual({ client_id: 'client-9', client_secret: 'shh' })
})

it('refuses to read a grant record written by another owner', async () => {
  const { ctx, credentials } = await mountContext()
  const url = 'http://127.0.0.1:1/mcp'
  credentials.records.set(authorizationKey(url), { kind: 'api-key', key: 'x' })
  await expect(hasStoredTokens(ctx, url)).rejects.toThrow(/unreadable/)
  credentials.records.set(authorizationKey(url), { kind: 'grant', payload: { version: 2 } })
  await expect(hasStoredTokens(ctx, url)).rejects.toThrow(/unreadable/)
})

it('clears a stored grant', async () => {
  const { ctx, credentials } = await mountContext()
  const url = 'http://127.0.0.1:1/mcp'
  credentials.records.set(authorizationKey(url), { kind: 'grant', payload: { version: 1, tokens: { access_token: 'a', token_type: 'Bearer' } } })
  expect(await hasStoredTokens(ctx, url)).toBe(true)
  await clearAuthorization(ctx, url)
  expect(await hasStoredTokens(ctx, url)).toBe(false)
})

it('fails a flow whose authorization server reports an error', async () => {
  const fixture = await startAuthorizationFixture()
  onTestFinished(fixture.close)
  const { ctx } = await mountContext()
  const flow = await beginAuthorization(ctx, oauthConfig(fixture.url), new AbortController().signal)
  const redirect = new URL(flow.url ?? '')
  const callback = new URL(redirect.searchParams.get('redirect_uri') ?? '')
  callback.searchParams.set('error', 'access_denied')
  callback.searchParams.set('error_description', 'user <denied>')
  const response = await fetch(callback)
  expect(response.status).toBe(400)
  expect(await response.text()).toContain('user &lt;denied&gt;')
  await expect(flow.completed).rejects.toThrow(/authorization failed: user <denied>/)
})

it('fails a flow that is cancelled or times out', async () => {
  const fixture = await startAuthorizationFixture()
  onTestFinished(fixture.close)
  const { ctx } = await mountContext()
  const cancelled = new AbortController()
  const flow = await beginAuthorization(ctx, oauthConfig(fixture.url), cancelled.signal)
  cancelled.abort(new Error('user closed the tab'))
  await expect(flow.completed).rejects.toThrow(/authorization cancelled/)

  const timed = await beginAuthorization(
    ctx, { ...oauthConfig(fixture.url), oauth: { authorizationTimeoutMs: 20 } }, new AbortController().signal,
  )
  await expect(timed.completed).rejects.toThrow(/timed out/)

  const already = new AbortController()
  already.abort(new Error('gone'))
  await expect(beginAuthorization(ctx, oauthConfig(fixture.url), already.signal)).rejects.toThrow(/authorization cancelled/)
})

it('reports an occupied callback port instead of starting a second listener', async () => {
  const fixture = await startAuthorizationFixture()
  onTestFinished(fixture.close)
  const { ctx } = await mountContext()
  const blocker = createServer()
  await new Promise<void>((resolve) => { blocker.listen(0, '127.0.0.1', resolve) })
  onTestFinished(() => { blocker.close() })
  const address = blocker.address()
  if (address === null || typeof address === 'string') throw new Error('blocker has no port')
  await expect(beginAuthorization(
    ctx, { ...oauthConfig(fixture.url), oauth: { callbackPort: address.port } }, new AbortController().signal,
  )).rejects.toThrow(/EADDRINUSE/)
})

it('reuses stored tokens without a second interactive flow', async () => {
  const fixture = await startAuthorizationFixture()
  onTestFinished(fixture.close)
  const { ctx } = await mountContext()
  const config = oauthConfig(fixture.url)
  const flow = await beginAuthorization(ctx, config, new AbortController().signal)
  await driveBrowser(flow.url ?? '')
  await flow.completed
  const again = await beginAuthorization(ctx, config, new AbortController().signal)
  expect(again.url).toBeUndefined()
  await expect(again.completed).resolves.toBeUndefined()
})

/** Credentials that accept writes and store nothing. */
class DroppingCredentials extends MemoryCredentials {
  override modifyRecord(): Promise<undefined> { return Promise.resolve(undefined) }
}

/** Credentials that store whatever the caller wrote. */
class CorruptingCredentials extends MemoryCredentials {
  override modifyRecord(): Promise<CredentialRecord> {
    return Promise.resolve({ kind: 'grant', payload: { version: 99 } })
  }
}

it('refuses OAuth helpers without a credentials provider', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await expect(hasStoredTokens(ctx, 'http://127.0.0.1:1/mcp')).rejects.toThrow(/credentials provider/)
  await expect(clearAuthorization(ctx, 'http://127.0.0.1:1/mcp')).rejects.toThrow(/credentials provider/)
  expect(() => createOAuthProvider(ctx, oauthConfig('http://127.0.0.1:1/mcp')))
    .toThrow(/credentials provider/)
  const { oauth: _oauth, ...unconfigured } = oauthConfig('http://127.0.0.1:1/mcp')
  expect(() => createOAuthProvider(ctx, unconfigured)).toThrow(/OAuth is not configured for this server/)
})

it('keeps a pre-registered public client without a secret', async () => {
  const { ctx } = await mountContext()
  const provider = createOAuthProvider(ctx, { ...oauthConfig('http://127.0.0.1:1/mcp'), oauth: { clientId: 'client-9' } })
  expect(await provider.clientInformation?.()).toEqual({ client_id: 'client-9' })
  expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none')
})

it('refuses to overwrite a grant record written by another owner', async () => {
  const { ctx, credentials } = await mountContext()
  const url = 'http://127.0.0.1:1/mcp'
  credentials.records.set(authorizationKey(url), { kind: 'api-key', key: 'x' })
  const provider = createOAuthProvider(ctx, oauthConfig(url))
  await expect(provider.saveTokens?.({ access_token: 'a', token_type: 'Bearer' })).rejects.toThrow(/unreadable/)
})

it('refuses a credentials provider that does not store the grant', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(DroppingCredentials)
  const provider = createOAuthProvider(ctx, oauthConfig('http://127.0.0.1:1/mcp'))
  await expect(provider.saveTokens?.({ access_token: 'a', token_type: 'Bearer' })).rejects.toThrow(/did not store/)
})

it('refuses a stored grant it cannot read back', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CorruptingCredentials)
  const provider = createOAuthProvider(ctx, oauthConfig('http://127.0.0.1:1/mcp'))
  await expect(provider.saveTokens?.({ access_token: 'a', token_type: 'Bearer' })).rejects.toThrow(/unreadable/)
})

it('serves only the callback path and rejects a callback without a code', async () => {
  const fixture = await startAuthorizationFixture()
  onTestFinished(fixture.close)
  const { ctx } = await mountContext()
  const flow = await beginAuthorization(ctx, oauthConfig(fixture.url), new AbortController().signal)
  const redirect = new URL(flow.url ?? '')
  const callback = new URL(redirect.searchParams.get('redirect_uri') ?? '')
  expect((await fetch(new URL('/other', callback))).status).toBe(404)
  const stateOnly = new URL(callback)
  stateOnly.searchParams.set('state', redirect.searchParams.get('state') ?? '')
  expect((await fetch(stateOnly)).status).toBe(400)
  await expect(flow.completed).rejects.toThrow(/state mismatch/)
})

it('accepts one callback and refuses a duplicate', async () => {
  const fixture = await startAuthorizationFixture()
  onTestFinished(fixture.close)
  const { ctx } = await mountContext()
  const flow = await beginAuthorization(ctx, oauthConfig(fixture.url), new AbortController().signal)
  const authorize = await fetch(flow.url ?? '', { redirect: 'manual' })
  const issued = new URL(authorize.headers.get('location') ?? '')
  // Hold the exchange open so the second callback arrives while one is pending.
  fixture.setTokenDelay(100)
  const responses = await Promise.all([fetch(issued), fetch(issued)])
  expect(responses.map(response => response.status)).toContain(409)
  await flow.completed
})
