/**
 * Record real HTTP traffic into a JSON cassette and replay it, so a test
 * exercises the exact wire requests and responses once and then runs keyless.
 * @module @deepseek-ai/dsh-test-support-http-cassette
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

/** How {@link createCassetteFetch} obtains each response. */
export type CassetteMode = 'record' | 'replay' | 'auto'

/**
 * What recording does when a request or response body contains a credential
 * pattern. `reject` refuses the write; `scrub` replaces each match.
 */
export type CassetteRedact = 'reject' | 'scrub'

/** Options accepted by {@link createCassetteFetch}. */
export interface CassetteFetchOptions {
  /** `record` always calls the network, `replay` reads only the cassette, `auto` replays when the file exists. */
  readonly mode: CassetteMode
  /** Directory holding `<name>.json`; created on the first write. */
  readonly dir: string
  /** Cassette name without `.json`; may name subdirectories. */
  readonly name: string
  /** Credential handling for recorded request and response bodies; defaults to `reject`. */
  readonly redact?: CassetteRedact
}

/** One recorded request. Matching compares method, URL, and body; headers never participate. */
export interface CassetteRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
  readonly bodyEncoding: 'text' | 'base64'
}

/** One recorded response; binary payloads carry `bodyEncoding: "base64"`. */
export interface CassetteResponse {
  readonly status: number
  readonly statusText: string
  readonly headers: Record<string, string>
  readonly body: string
  readonly bodyEncoding: 'text' | 'base64'
}

/** One request/response pair in a cassette file. */
export interface CassetteInteraction {
  readonly request: CassetteRequest
  readonly response: CassetteResponse
}

/** On-disk cassette. Consumption state stays in memory and never lands here. */
export interface Cassette {
  readonly version: 1
  readonly name: string
  readonly recordedAt: string
  readonly interactions: readonly CassetteInteraction[]
}

/** A `fetch` that records or replays, plus the completeness assertions tests call at the end. */
export type CassetteFetch = typeof fetch & {
  /** Throws when replay left recorded interactions unconsumed; a no-op while recording. */
  readonly assertComplete: () => void
  /** Alias of {@link CassetteFetch.assertComplete} for `try/finally` teardown. */
  readonly dispose: () => void
}

/** Replacement text written for a redacted value. */
const REDACTED = '[REDACTED]'

/** Headers removed before a request or response reaches the cassette. */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-amz-security-token',
  'x-goog-api-key',
])

/** Query parameters whose values are replaced with {@link REDACTED}. */
const SENSITIVE_QUERY_PARAMETERS: ReadonlySet<string> = new Set([
  'access_token',
  'api-key',
  'api_key',
  'apikey',
  'code',
  'key',
  'password',
  'secret',
  'sig',
  'signature',
  'token',
  'x-amz-credential',
  'x-amz-security-token',
  'x-amz-signature',
])

/** Credential formats refused or scrubbed in recorded bodies. */
const SECRET_PATTERNS: readonly { readonly label: string; readonly source: string; readonly flags: string }[] = [
  { label: 'API key', source: String.raw`\bsk-[A-Za-z0-9_-]{20,}\b`, flags: '' },
  { label: 'bearer token', source: String.raw`\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b`, flags: 'i' },
  { label: 'AWS access key', source: String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, flags: '' },
  { label: 'GitHub token', source: String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}\b`, flags: '' },
  { label: 'Google API key', source: String.raw`\bAIza[0-9A-Za-z_-]{20,}\b`, flags: '' },
  { label: 'private key', source: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`, flags: '' },
]

/** Media types recorded as text even though they carry no `text/` or `+json` suffix. */
const TEXTUAL_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/sql',
  'application/x-www-form-urlencoded',
  'application/xml',
  'application/yaml',
  'image/svg+xml',
])

/** One replay slot; `used` exists only in memory so ordered retries can be modeled. */
interface PlaybackSlot {
  readonly interaction: CassetteInteraction
  used: boolean
}

/**
 * Build a `fetch` that records real responses into `<dir>/<name>.json` or
 * replays them from that file.
 *
 * Recording overwrites the cassette with the interactions of this instance.
 * Replay consumes matching interactions in cassette order: an incoming request
 * takes the first unconsumed entry with the same method, URL, and canonical
 * body, so retries and polling replay their recorded responses in sequence.
 *
 * @param options - Mode, cassette location, and body redaction policy.
 * @returns A `fetch` whose `assertComplete` (or `dispose`) reports unconsumed replay entries.
 * @throws When `replay` names a missing or malformed cassette, or when `record` runs with `CI` set.
 *   A recorded body that matches a credential pattern fails that request unless `redact` is `scrub`.
 */
export function createCassetteFetch(options: CassetteFetchOptions): CassetteFetch {
  const path = cassettePath(options.dir, options.name)
  const mode: 'record' | 'replay' = options.mode === 'auto'
    ? existsSync(path) ? 'replay' : 'record'
    : options.mode
  if (mode === 'record' && isContinuousIntegration()) {
    throw new Error(
      `http-cassette: refusing to record "${options.name}" while CI is set; record the cassette locally and commit it, or create the fetch in replay mode`,
    )
  }
  if (mode === 'replay' && !existsSync(path)) {
    throw new Error(
      `http-cassette: cassette "${options.name}" not found at ${path}; record it locally before replaying`,
    )
  }

  const policy: CassetteRedact = options.redact ?? 'reject'
  const recordedAt = new Date().toISOString()
  const captured: CassetteInteraction[] = []
  const playback: PlaybackSlot[] = mode === 'replay'
    ? readCassette(path, options.name).interactions.map(interaction => ({ interaction, used: false }))
    : []
  const upstream = globalThis.fetch

  const cassetteFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const incoming = await snapshotRequest(request, policy)
    if (mode === 'record') {
      const response = await upstream(request)
      const capturedResponse = await snapshotResponse(response, policy)
      captured.push({ request: incoming, response: capturedResponse })
      writeCassette(path, options.name, recordedAt, captured)
      return response
    }
    const slot = playback.find(entry => !entry.used && sameRequest(entry.interaction.request, incoming))
    if (slot === undefined) {
      throw new Error(
        `http-cassette: no unconsumed entry in "${options.name}" matches ${describeRequest(incoming)}; recorded ${String(playback.length)} interaction(s)`,
      )
    }
    slot.used = true
    return responseFrom(slot.interaction.response)
  }

  const assertComplete = (): void => {
    const unused = playback.filter(slot => !slot.used).length
    if (unused === 0) return
    throw new Error(
      `http-cassette: ${String(unused)} of ${String(playback.length)} interaction(s) in "${options.name}" were never consumed`,
    )
  }

  return Object.assign(cassetteFetch, { assertComplete, dispose: assertComplete })
}

/**
 * Resolve the cassette file and reject names that escape the directory.
 * @param directory - Recording directory from {@link CassetteFetchOptions.dir}.
 * @param name - Cassette name from {@link CassetteFetchOptions.name}.
 * @returns Absolute path of `<directory>/<name>.json`.
 * @throws When the name is empty, absolute, or climbs out of the directory.
 */
function cassettePath(directory: string, name: string): string {
  if (name.trim() === '' || isAbsolute(name) || name.split(/[\\/]/u).includes('..')) {
    throw new Error(`http-cassette: invalid cassette name ${JSON.stringify(name)}`)
  }
  return resolve(directory, `${name}.json`)
}

/**
 * Read and validate one cassette file.
 * @param path - Absolute cassette path.
 * @param name - Cassette name used in diagnostics.
 * @returns The decoded cassette.
 * @throws When the JSON is malformed or an interaction field is missing or mistyped.
 */
function readCassette(path: string, name: string): Cassette {
  const invalid = (detail: string): Error =>
    new Error(`http-cassette: cassette "${name}" at ${path} is invalid: ${detail}`)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw invalid(String(error))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw invalid(String(error))
  }
  if (!isRecord(parsed)) throw invalid('top level is not an object')
  if (parsed.version !== 1) throw invalid('version must be 1')
  if (typeof parsed.name !== 'string') throw invalid('name must be a string')
  if (typeof parsed.recordedAt !== 'string') throw invalid('recordedAt must be a string')
  if (!Array.isArray(parsed.interactions)) throw invalid('interactions must be an array')
  return {
    version: 1,
    name: parsed.name,
    recordedAt: parsed.recordedAt,
    interactions: parsed.interactions.map((interaction, index) => decodeInteraction(interaction, index, invalid)),
  }
}

/**
 * Validate one interaction read from disk.
 * @param value - Untrusted interaction value.
 * @param index - Position used in diagnostics.
 * @param invalid - Error factory bound to the cassette name and path.
 * @returns The validated interaction.
 */
function decodeInteraction(
  value: unknown,
  index: number,
  invalid: (detail: string) => Error,
): CassetteInteraction {
  if (!isRecord(value)) throw invalid(`interactions[${String(index)}] is not an object`)
  const request = decodeRequest(value.request, index, invalid)
  const response = decodeResponse(value.response, index, invalid)
  return { request, response }
}

function decodeRequest(value: unknown, index: number, invalid: (detail: string) => Error): CassetteRequest {
  if (!isRecord(value)) throw invalid(`interactions[${String(index)}].request is not an object`)
  return {
    method: requireString(value.method, `interactions[${String(index)}].request.method`, invalid),
    url: requireString(value.url, `interactions[${String(index)}].request.url`, invalid),
    headers: requireHeaders(value.headers, `interactions[${String(index)}].request.headers`, invalid),
    body: requireString(value.body, `interactions[${String(index)}].request.body`, invalid),
    bodyEncoding: decodeEncoding(value.bodyEncoding, `interactions[${String(index)}].request.bodyEncoding`, invalid),
  }
}

function decodeResponse(value: unknown, index: number, invalid: (detail: string) => Error): CassetteResponse {
  if (!isRecord(value)) throw invalid(`interactions[${String(index)}].response is not an object`)
  if (typeof value.status !== 'number') {
    throw invalid(`interactions[${String(index)}].response.status must be a number`)
  }
  return {
    status: value.status,
    statusText: requireString(value.statusText, `interactions[${String(index)}].response.statusText`, invalid),
    headers: requireHeaders(value.headers, `interactions[${String(index)}].response.headers`, invalid),
    body: requireString(value.body, `interactions[${String(index)}].response.body`, invalid),
    bodyEncoding: decodeEncoding(value.bodyEncoding, `interactions[${String(index)}].response.bodyEncoding`, invalid),
  }
}

function decodeEncoding(
  value: unknown,
  field: string,
  invalid: (detail: string) => Error,
): 'text' | 'base64' {
  if (value === 'text' || value === 'base64') return value
  throw invalid(`${field} must be "text" or "base64"`)
}

function requireString(value: unknown, field: string, invalid: (detail: string) => Error): string {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`)
  return value
}

function requireHeaders(
  value: unknown,
  field: string,
  invalid: (detail: string) => Error,
): Record<string, string> {
  if (!isRecord(value)) throw invalid(`${field} must be an object`)
  const headers: Record<string, string> = {}
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== 'string') throw invalid(`${field}.${name} must be a string`)
    headers[name] = headerValue
  }
  return headers
}

/**
 * Write the cassette through a temporary sibling so a failed write never leaves a partial file.
 * @param path - Absolute cassette path.
 * @param name - Cassette name stored in the file.
 * @param recordedAt - Timestamp of the recording session.
 * @param interactions - Interactions captured so far, in request order.
 */
function writeCassette(
  path: string,
  name: string,
  recordedAt: string,
  interactions: readonly CassetteInteraction[],
): void {
  const cassette: Cassette = { version: 1, name, recordedAt, interactions }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(cassette, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/**
 * Snapshot an incoming request with redaction applied before anything reaches the cassette.
 * @param request - Request about to be sent upstream.
 * @param policy - Credential handling for the body.
 * @returns The request as stored and matched.
 */
async function snapshotRequest(request: Request, policy: CassetteRedact): Promise<CassetteRequest> {
  const bytes = new Uint8Array(await request.clone().arrayBuffer())
  const base64 = bytes.byteLength > 0 && !isTextual(request.headers.get('content-type'))
  const body = base64 ? Buffer.from(bytes).toString('base64') : new TextDecoder().decode(bytes)
  return {
    method: request.method.toUpperCase(),
    url: redactUrl(request.url),
    headers: omitSensitiveHeaders(Object.fromEntries(request.headers.entries())),
    body: base64 ? body : applyBodyPolicy(body, policy, 'request body'),
    bodyEncoding: base64 ? 'base64' : 'text',
  }
}

/**
 * Snapshot a real response with redaction applied before anything reaches the cassette.
 * @param response - Response returned by the upstream call.
 * @param policy - Credential handling for textual bodies.
 * @returns The response as stored.
 */
async function snapshotResponse(response: Response, policy: CassetteRedact): Promise<CassetteResponse> {
  const bytes = new Uint8Array(await response.clone().arrayBuffer())
  const base64 = bytes.byteLength > 0 && !isTextual(response.headers.get('content-type'))
  const body = base64 ? Buffer.from(bytes).toString('base64') : new TextDecoder().decode(bytes)
  return {
    status: response.status,
    statusText: response.statusText,
    headers: omitSensitiveHeaders(Object.fromEntries(response.headers.entries())),
    body: base64 ? body : applyBodyPolicy(body, policy, 'response body'),
    bodyEncoding: base64 ? 'base64' : 'text',
  }
}

/**
 * Rebuild a `Response` from a recorded snapshot.
 * @param snapshot - Recorded status, headers, and body.
 * @returns A response whose body reproduces the recorded bytes.
 */
function responseFrom(snapshot: CassetteResponse): Response {
  const decoded = snapshot.bodyEncoding === 'base64'
    ? Buffer.from(snapshot.body, 'base64')
    : snapshot.body
  const bodyless = snapshot.status === 204 || snapshot.status === 205 || snapshot.status === 304
  return new Response(bodyless ? null : decoded, {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  })
}

/**
 * Compare a recorded request with an incoming one.
 * @param recorded - Request stored in the cassette.
 * @param incoming - Request redacted from the live call.
 * @returns Whether replay may serve the recorded response.
 */
function sameRequest(recorded: CassetteRequest, incoming: CassetteRequest): boolean {
  return recorded.method === incoming.method
    && recorded.url === incoming.url
    && canonicalBody(recorded) === canonicalBody(incoming)
}

/**
 * Normalize a request body so JSON key order and entity encoding do not affect matching.
 * @param request - Request snapshot holding the body.
 * @returns Canonical text for comparison.
 */
function canonicalBody(request: CassetteRequest): string {
  if (request.bodyEncoding === 'base64') return `base64:${request.body}`
  if (request.body === '') return ''
  try {
    return JSON.stringify(canonicalizeJson(JSON.parse(request.body)))
  } catch (_notJson) {
    return request.body
  }
}

/**
 * Sort object keys recursively so equal JSON values compare equal regardless of member order.
 * @param value - Parsed JSON value.
 * @returns The same value with object members ordered by key.
 */
function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalizeJson(child)] as const),
  )
}

/**
 * Report whether a request or response body is text or binary.
 * @param contentType - Raw `content-type` header value.
 * @returns True when the media type is textual.
 */
function isTextual(contentType: string | null): boolean {
  if (contentType === null) return true
  const separator = contentType.indexOf(';')
  const mediaType = (separator === -1 ? contentType : contentType.slice(0, separator)).trim().toLowerCase()
  return mediaType === ''
    || mediaType.startsWith('text/')
    || mediaType.endsWith('+json')
    || mediaType.endsWith('+xml')
    || TEXTUAL_MEDIA_TYPES.has(mediaType)
}

/**
 * Replace credential values in sensitive query parameters.
 * @param raw - Request URL.
 * @returns The URL with userinfo and sensitive query values replaced.
 */
function redactUrl(raw: string): string {
  const url = new URL(raw)
  for (const name of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMETERS.has(name.toLowerCase())) url.searchParams.set(name, REDACTED)
  }
  return url.toString()
}

/**
 * Drop credential-bearing headers and normalize the remaining names.
 * @param headers - Headers captured from the live request or response.
 * @returns Lowercased headers in sorted order without sensitive names.
 */
function omitSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(([name]) => !SENSITIVE_HEADERS.has(name))
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

/**
 * Apply the credential policy to a textual body.
 * @param body - Body text about to be recorded.
 * @param policy - `reject` refuses the write, `scrub` replaces each match.
 * @param context - Diagnostic name of the body being recorded.
 * @returns The body to record, possibly scrubbed.
 * @throws When the body matches a credential pattern and the policy is `reject`.
 */
function applyBodyPolicy(body: string, policy: CassetteRedact, context: string): string {
  const labels = SECRET_PATTERNS
    .filter(pattern => new RegExp(pattern.source, pattern.flags).test(body))
    .map(pattern => pattern.label)
  if (labels.length === 0) return body
  if (policy === 'scrub') return scrubSecrets(body)
  throw new Error(
    `http-cassette: refusing to record the ${context} because it contains possible credentials (${[...new Set(labels)].join(', ')}); pass redact: "scrub" to replace them`,
  )
}

/**
 * Replace every credential match with {@link REDACTED}.
 * @param text - Body text holding one or more matches.
 * @returns The scrubbed text.
 */
function scrubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (value, pattern) => value.replace(new RegExp(pattern.source, `${pattern.flags}g`), REDACTED),
    text,
  )
}

/**
 * Report whether the run is a CI run that must not write new cassettes.
 * @returns True for any non-empty `CI` value except `false` and `0`.
 */
function isContinuousIntegration(): boolean {
  const value = process.env.CI
  return value !== undefined && value !== '' && value !== 'false' && value !== '0'
}

/**
 * Report whether a parsed JSON value is a plain object.
 * @param value - Parsed JSON value.
 * @returns True for non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Describe a request for a failed-match diagnostic.
 * @param request - Incoming request snapshot.
 * @returns One-line description without the body.
 */
function describeRequest(request: CassetteRequest): string {
  return `${request.method} ${request.url}`
}
