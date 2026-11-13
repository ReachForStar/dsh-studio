/**
 * OAuth for remote MCP servers: the client provider the SDK transport drives,
 * the interactive loopback authorization flow, and the durable grant.
 *
 * The grant lives in one `credentials` record keyed by the server URL, so a
 * rotated credential reaches the next connection without a restart, and two
 * processes refresh the same refresh token under one lock. The transport keeps
 * the stored tokens and asks the SDK to refresh them; this module never reads
 * a token for display and never logs one.
 *
 * @module
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
} from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { credentialKey, type CredentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import Schema from '@deepseek-ai/schemastery'
import { McpLocalError } from './diagnostic.ts'
import type { Config, OAuthConfig, StreamableHttpConfig } from './index.ts'

/** Default budget for one interactive authorization, in milliseconds. */
export const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 600_000

/** OAuth section schema shared by the client config and the manager's entry schema. */
export const OAuthSchema: Schema<OAuthConfig> = Schema.object({
  clientId: Schema.string(),
  clientSecret: Schema.string(),
  scope: Schema.string(),
  callbackPort: Schema.number().step(1).min(1).max(65_535),
  authorizationTimeoutMs: Schema.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
})

/** Path the authorization server redirects the browser back to. */
const CALLBACK_PATH = '/callback'

/**
 * Read the OAuth settings of one resolved configuration. The configuration
 * schema materializes an absent section as an empty object, which states the
 * same thing as an omitted one.
 * @param config - resolved configuration.
 * @returns the settings, or undefined when the server does not authorize.
 */
export function oauthSettings(config: Config): OAuthConfig | undefined {
  if (config.transport !== 'streamable-http') return undefined
  const oauth = config.oauth
  return oauth === undefined || Object.keys(oauth).length === 0 ? undefined : oauth
}

/**
 * Narrow one resolved configuration to a server that authorizes.
 * @param config - resolved configuration.
 * @returns whether the server carries OAuth settings.
 */
export function isOAuthServer(config: Config): config is StreamableHttpConfig {
  return oauthSettings(config) !== undefined
}

/** Persisted shape of one server's authorization grant. */
const grantSchema = z.object({
  version: z.literal(1),
  clientInformation: z.object({
    client_id: z.string(),
    client_secret: z.string().optional(),
    client_id_issued_at: z.number().optional(),
    client_secret_expires_at: z.number().optional(),
    issuer: z.string().optional(),
  }).optional(),
  tokens: z.object({
    access_token: z.string(),
    id_token: z.string().optional(),
    token_type: z.string(),
    expires_in: z.number().optional(),
    scope: z.string().optional(),
    refresh_token: z.string().optional(),
    issuer: z.string().optional(),
  }).optional(),
  codeVerifier: z.string().optional(),
  state: z.string().optional(),
  redirectUri: z.string().optional(),
})

/** One server's stored authorization grant. */
type Grant = z.infer<typeof grantSchema>

/** One started authorization: the URL a user opens, and its settlement. */
export interface McpAuthorization {
  /** URL the user opens to grant access; absent when stored tokens already authorized. */
  readonly url?: string
  /** Settles when the grant is stored; rejects on cancellation, timeout, or a refused callback. */
  readonly completed: Promise<void>
}

/** Optional flow context a provider needs beyond the server configuration. */
export interface OAuthProviderOptions {
  /** Loopback URL for an interactive flow. */
  redirectUri?: string
  /** Receives the authorization URL an interactive flow must show the user. */
  onAuthorizationUrl?: (url: URL) => void
  /** State this flow already persisted and will validate on the callback. */
  state?: string
}

/**
 * Credential-record key for one server's grant. The id derives from the
 * server URL so every instance pointed at the same server shares the grant,
 * while the credentials grammar keeps the two key spaces apart.
 * @param url - the MCP endpoint URL from the resolved configuration.
 * @returns the record key.
 */
export function authorizationKey(url: string): CredentialKey {
  return credentialKey('mcp-client', `server-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`)
}

/** Durable grant access through the credentials seam. */
class GrantStore {
  /**
   * @param ctx - context providing the credentials provider.
   * @param key - the server's grant record key.
   */
  constructor(private readonly ctx: Context, readonly key: CredentialKey) {}

  /**
   * Read the stored grant, or an empty one.
   * @returns the parsed grant.
   * @throws when the record is not a grant this module can read.
   */
  async read(): Promise<Grant> {
    const record = await this.provider().readRecord(this.key)
    if (record === undefined) return { version: 1 }
    if (record.kind !== 'grant') throw this.unreadable()
    const parsed = grantSchema.safeParse(record.payload)
    if (!parsed.success) throw this.unreadable()
    return parsed.data
  }

  /**
   * Replace the grant under the seam's exclusive write.
   * @param mutate - receives the current grant and returns its replacement.
   * @returns the stored grant.
   */
  async update(mutate: (grant: Grant) => Grant): Promise<Grant> {
    const next = await this.provider().modifyRecord(this.key, (current) => {
      const parsed = current === undefined
        ? undefined
        : current.kind === 'grant' ? grantSchema.safeParse(current.payload) : null
      if (parsed === null || parsed?.success === false) throw this.unreadable()
      return Promise.resolve({ kind: 'grant', payload: mutate(parsed?.data ?? { version: 1 }) })
    })
    if (next?.kind !== 'grant') throw new McpLocalError('mcp-client: the credentials provider did not store the MCP authorization grant')
    const parsed = grantSchema.safeParse(next.payload)
    if (!parsed.success) throw this.unreadable()
    return parsed.data
  }

  private provider(): CredentialProvider {
    const provider = this.ctx.get('credentials')
    if (provider === undefined) throw new McpLocalError('MCP OAuth requires a credentials provider')
    return provider
  }

  private unreadable(): McpLocalError {
    return new McpLocalError(`mcp-client: stored authorization for this server is unreadable; clear the "${String(this.key)}" credential record`)
  }
}

/**
 * Whether an authorization grant with tokens is stored for one server.
 * @param ctx - context providing the credentials provider.
 * @param url - the MCP endpoint URL.
 * @returns true when the stored grant can present a token.
 */
export async function hasStoredTokens(ctx: Context, url: string): Promise<boolean> {
  return (await new GrantStore(ctx, authorizationKey(url)).read()).tokens !== undefined
}

/**
 * Read the loopback redirect URI an earlier authorization registered, so a
 * refresh can run without another interactive flow.
 * @param ctx - context providing the credentials provider.
 * @param url - the MCP endpoint URL.
 * @returns the stored redirect URI, or undefined before the first authorization.
 */
export async function storedRedirectUri(ctx: Context, url: string): Promise<string | undefined> {
  return (await new GrantStore(ctx, authorizationKey(url)).read()).redirectUri
}

/**
 * Create the OAuth client provider one connection uses.
 *
 * Without a stored grant the transport cannot present a token and the
 * handshake fails with the SDK's `UnauthorizedError`, which the supervisor
 * reports as `waiting-authorization` instead of retrying.
 * @param ctx - context providing the credentials provider.
 * @param config - resolved Streamable HTTP configuration; `oauth` must be set.
 * @param options - loopback redirect, authorization-URL sink, and the flow's persisted state.
 * @returns the provider the SDK transport drives.
 * @throws when the credentials provider is missing.
 */
export function createOAuthProvider(
  ctx: Context,
  config: StreamableHttpConfig,
  options: OAuthProviderOptions = {},
): OAuthClientProvider {
  const oauth = oauthSettings(config)
  if (oauth === undefined) throw new McpLocalError('mcp-client: OAuth is not configured for this server')
  if (ctx.get('credentials') === undefined) throw new McpLocalError('MCP OAuth requires a credentials provider')
  const store = new GrantStore(ctx, authorizationKey(config.url))
  const staticClient: StoredOAuthClientInformation | undefined = oauth.clientId === undefined
    ? undefined
    : { client_id: oauth.clientId, ...oauth.clientSecret === undefined ? {} : { client_secret: oauth.clientSecret } }
  // Both legs of one interactive flow share this instance, so the SDK's
  // discovery state and its issuer check stay consistent without persistence.
  let discovery: OAuthDiscoveryState | undefined
  return {
    redirectUrl: options.redirectUri,
    clientMetadata: {
      client_name: 'DeepSeek Harness',
      redirect_uris: options.redirectUri === undefined ? [] : [options.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: oauth.clientSecret === undefined ? 'none' : 'client_secret_post',
      ...oauth.scope === undefined ? {} : { scope: oauth.scope },
    },
    clientInformation: async () => staticClient ?? (await store.read()).clientInformation,
    saveClientInformation: async (information) => { await store.update(grant => ({ ...grant, clientInformation: information })) },
    tokens: async () => (await store.read()).tokens,
    saveTokens: async (tokens) => { await store.update(grant => ({ ...grant, tokens })) },
    saveCodeVerifier: async (verifier) => { await store.update(grant => ({ ...grant, codeVerifier: verifier })) },
    codeVerifier: async () => {
      const verifier = (await store.read()).codeVerifier
      if (verifier === undefined) throw new McpLocalError('mcp-client: the authorization callback arrived without a stored PKCE verifier')
      return verifier
    },
    state: async () => {
      if (options.state !== undefined) return options.state
      const state = randomBytes(32).toString('base64url')
      await store.update(grant => ({ ...grant, state }))
      return state
    },
    redirectToAuthorization: (url) => {
      if (options.onAuthorizationUrl === undefined) {
        throw new McpLocalError('mcp-client: this server needs user authorization; run the authorize command for it')
      }
      options.onAuthorizationUrl(url)
    },
    discoveryState: () => discovery,
    saveDiscoveryState: (state) => { discovery = state },
  }
}

/**
 * Start an interactive authorization for one server.
 *
 * The loopback listener accepts exactly one redirect on `/callback`; a wrong
 * state, a missing code, or an expired budget fails the flow and closes it.
 * @param ctx - context providing the credentials provider.
 * @param config - resolved Streamable HTTP configuration; `oauth` must be set.
 * @param signal - cancels the flow and closes the listener.
 * @returns the URL to show the user and the flow's settlement.
 * @throws when the server is not configured for OAuth, the credentials provider is missing, or the listener cannot bind.
 */
export async function beginAuthorization(
  ctx: Context,
  config: StreamableHttpConfig,
  signal: AbortSignal,
): Promise<McpAuthorization> {
  const oauth = oauthSettings(config)
  if (oauth === undefined) throw new McpLocalError(`mcp-client(${config.serverName}): OAuth is not configured for this server`)
  const store = new GrantStore(ctx, authorizationKey(config.url))
  const server = createServer()
  const cancelled = Promise.withResolvers<never>()
  // The rejection is observed by whichever leg is waiting; guard the case where none is.
  void cancelled.promise.catch(() => undefined)
  const onAbort = (): void => { cancelled.reject(new McpLocalError(`mcp-client(${config.serverName}): authorization cancelled`)) }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const state = randomBytes(32).toString('base64url')
  const received = Promise.withResolvers<string>()
  void received.promise.catch(() => undefined)
  let pending: ServerResponse | undefined
  let authorizationUrl: URL | undefined
  server.on('request', (request, response) => {
    /* v8 ignore next -- Node sets request.url for every HTTP/1.1 request */
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { 'cache-control': 'no-store' }).end()
      return
    }
    const failure = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    if (failure !== null) {
      response.writeHead(400, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
        .end(page('Authorization failed', failure))
      received.reject(new McpLocalError(`mcp-client(${config.serverName}): authorization failed: ${failure}`))
      return
    }
    const states = url.searchParams.getAll('state')
    const codes = url.searchParams.getAll('code')
    if (states.length !== 1 || codes.length !== 1 || !sameSecret(states[0] ?? '', state)) {
      response.writeHead(400, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
        .end(page('Authorization failed', 'The callback did not match this request.'))
      received.reject(new McpLocalError(`mcp-client(${config.serverName}): authorization state mismatch`))
      return
    }
    if (pending !== undefined) {
      response.writeHead(409, { 'cache-control': 'no-store' }).end()
      return
    }
    pending = response
    /* v8 ignore next -- the length check above guarantees one code */
    received.resolve(codes[0] ?? '')
  })
  const timeoutMs = oauth.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS
  const timer = setTimeout(() => {
    received.reject(new McpLocalError(`mcp-client(${config.serverName}): authorization timed out after ${String(timeoutMs)}ms`))
  }, timeoutMs)
  timer.unref()
  // The listener and timer live for the whole flow, including the wait for the
  // browser, and are released only when it settles.
  const cleanup = (): void => {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
  try {
    const port = await listen(server, oauth.callbackPort)
    const redirectUri = `http://127.0.0.1:${String(port)}${CALLBACK_PATH}`
    await store.update(grant => ({ ...grant, redirectUri, state }))
    const provider = createOAuthProvider(ctx, config, {
      redirectUri,
      state,
      onAuthorizationUrl: (url) => { authorizationUrl = url },
    })
    const outcome = await Promise.race([
      auth(provider, { serverUrl: config.url, ...oauth.scope === undefined ? {} : { scope: oauth.scope } }),
      cancelled.promise,
    ])
    if (outcome === 'AUTHORIZED') {
      cleanup()
      server.close()
      return { completed: Promise.resolve() }
    }
    /* v8 ignore next 2 -- the SDK returns REDIRECT only after calling redirectToAuthorization */
    if (authorizationUrl === undefined) {
      throw new McpLocalError(`mcp-client(${config.serverName}): the authorization server returned no authorization URL`)
    }
    const completed = (async () => {
      const code = await Promise.race([received.promise, cancelled.promise])
      const result = await auth(provider, { serverUrl: config.url, authorizationCode: code })
      /* v8 ignore next -- an authorization-code exchange either stores tokens or throws */
      if (result !== 'AUTHORIZED') throw new McpLocalError(`mcp-client(${config.serverName}): the authorization server did not grant access`)
      pending?.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
        .end(page('Authorization complete', 'You can close this window.'))
    })().catch((error: unknown) => {
      pending?.writeHead(400, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
        .end(page('Authorization failed', 'The harness could not complete the exchange.'))
      throw error
    }).finally(() => {
      cleanup()
      server.close()
    })
    // The caller observes the rejection; this keeps a late observer from
    // turning it into an unhandled rejection.
    void completed.catch(() => undefined)
    return { url: authorizationUrl.toString(), completed }
  } catch (error) {
    cleanup()
    server.close()
    throw error
  }
}

/**
 * Clear one server's stored grant, forcing the next connection to authorize again.
 * @param ctx - context providing the credentials provider.
 * @param url - the MCP endpoint URL.
 * @throws when the credentials provider is missing.
 */
export async function clearAuthorization(ctx: Context, url: string): Promise<void> {
  const provider = ctx.get('credentials')
  if (provider === undefined) throw new McpLocalError('MCP OAuth requires a credentials provider')
  await provider.deleteRecord(authorizationKey(url))
}

/**
 * Compare two short secrets without leaking their common prefix length.
 * @param left - received value.
 * @param right - expected value.
 * @returns whether they are byte-identical.
 */
function sameSecret(left: string, right: string): boolean {
  return Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

/** Bind the loopback listener and report its port. */
async function listen(server: Server, port: number | undefined): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port ?? 0, '127.0.0.1', resolve)
  })
  const address = server.address()
  /* v8 ignore next -- a bound TCP listener always reports an AddressInfo */
  if (address === null || typeof address === 'string') throw new McpLocalError('mcp-client: the authorization listener has no TCP address')
  return address.port
}

/** Minimal completion page; it carries only fixed text and the server's error code. */
function page(title: string, detail: string): string {
  const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><h1>${escape(title)}</h1><p>${escape(detail)}</p>`
}
