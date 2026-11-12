/**
 * Execution of one planned operation: URL substitution, parameter
 * serialization, authentication, transport, and response normalization.
 * @module @deepseek-ai/dsh-openapi-tools/runtime
 */

import { HarnessError } from '@deepseek-ai/dsh-error'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { OperationPlan, PlannedField } from './spec.ts'

/** How the plugin sends a resolved credential. */
export interface AuthSetting {
  /** Transport carrying the secret. */
  readonly scheme: 'bearer' | 'header' | 'query'
  /** Header or query parameter name for `header` and `query` schemes. */
  readonly name?: string | undefined
  /** Resolve the current secret; called once per request so a rotated value is used immediately. */
  resolve(): Promise<string | undefined>
}

/** Per-request settings shared by every operation of one document. */
export interface InvokeOptions {
  /** Static headers sent on every request. */
  readonly headers: Readonly<Record<string, string>>
  /** Optional host-side authentication. */
  readonly auth?: AuthSetting | undefined
  /** Request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Cap on a returned non-JSON body, in characters. */
  readonly maxResponseChars: number
  /** Cap on the body quoted in an HTTP failure, in characters. */
  readonly maxErrorBodyChars: number
  /** Caller cancellation. */
  readonly signal: AbortSignal
}

/**
 * Execute one planned operation.
 * @param plan - URL, field routing, and body facts of the operation.
 * @param args - validated arguments keyed by `inputName`.
 * @param options - transport, authentication, and size limits.
 * @returns the parsed JSON value, a truncated text body, or `null` for an empty body.
 * @throws HarnessError on credential, transport, HTTP, or JSON-decoding failure.
 */
export async function invoke(
  plan: OperationPlan,
  args: Readonly<Record<string, unknown>>,
  options: InvokeOptions,
): Promise<JsonValue> {
  const query: Array<[string, string]> = []
  const headers = new Headers(options.headers)
  for (const field of plan.fields) {
    const value = args[field.inputName]
    if (value === undefined) continue
    if (field.location === 'query') query.push(...serializeQuery(field, value))
    if (field.location === 'header') headers.set(field.name, serializeSimple(field, value, String))
  }
  const url = buildUrl(plan, args)

  if (options.auth !== undefined) {
    const secret = await options.auth.resolve()
    if (secret === undefined) {
      throw new HarnessError(
        `openapi-tools: ${plan.method} ${plan.path} needs its configured credential, which is not available`,
        'OPENAPI_CREDENTIAL_MISSING',
      )
    }
    if (options.auth.scheme === 'bearer') headers.set('authorization', `Bearer ${secret}`)
    if (options.auth.scheme === 'header') headers.set(requireAuthName(options.auth), secret)
    if (options.auth.scheme === 'query') query.push([requireAuthName(options.auth), secret])
  }

  const bodyField = plan.body === undefined
    ? undefined
    : plan.fields.find(field => field.location === 'body')
  const bodyValue = bodyField === undefined ? undefined : args[bodyField.inputName]
  const body = bodyValue === undefined ? undefined : JSON.stringify(bodyValue)
  if (body !== undefined && plan.body !== undefined) headers.set('content-type', plan.body.mediaType)

  const target = query.length === 0 ? url : `${url}?${new URLSearchParams(query).toString()}`
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
  const response = await request(
    plan,
    target,
    { method: plan.method, headers, signal, ...body === undefined ? {} : { body } },
    options,
  )
  const text = await readBody(plan, response, options)
  const json = isJsonContentType(response.headers.get('content-type'))

  if (!response.ok) {
    const detail = text === '' ? 'no response body' : truncate(text, options.maxErrorBodyChars)
    throw new HarnessError(
      `openapi-tools: ${plan.method} ${plan.path} failed with HTTP ${String(response.status)}: ${detail}`,
      'OPENAPI_HTTP_ERROR',
    )
  }
  if (text === '') return null
  if (!json) return truncate(text, options.maxResponseChars)
  try {
    return JSON.parse(text) as JsonValue
  } catch (cause) {
    throw new HarnessError(
      `openapi-tools: ${plan.method} ${plan.path} returned malformed JSON`,
      'OPENAPI_RESPONSE_INVALID',
      { cause },
    )
  }
}

/** Send one request, translating transport failures while preserving caller cancellation. */
async function request(
  plan: OperationPlan,
  url: string,
  init: RequestInit,
  options: InvokeOptions,
): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (cause) {
    if (options.signal.aborted) throw cause
    const reason = init.signal?.aborted === true ? `timed out after ${String(options.timeoutMs)} ms` : describeCause(cause)
    throw new HarnessError(
      `openapi-tools: ${plan.method} ${plan.path} failed before a response: ${reason}`,
      'OPENAPI_REQUEST_FAILED',
      { cause },
    )
  }
}

/** Read the reply body, preserving caller cancellation. */
async function readBody(plan: OperationPlan, response: Response, options: InvokeOptions): Promise<string> {
  try {
    return await response.text()
  } catch (cause) {
    if (options.signal.aborted) throw cause
    throw new HarnessError(
      `openapi-tools: reading the ${plan.method} ${plan.path} response failed`,
      'OPENAPI_REQUEST_FAILED',
      { cause },
    )
  }
}

/** Render a thrown transport failure as one line. */
function describeCause(cause: unknown): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : 'transport error'
}

/** A bearer-authenticated request carries no header name configuration. */
function requireAuthName(auth: AuthSetting): string {
  if (auth.name === undefined) {
    throw new HarnessError(`openapi-tools: the ${auth.scheme} authentication scheme needs a parameter name`, 'OPENAPI_AUTH_INVALID')
  }
  return auth.name
}

/** Substitute path parameters, rejecting values URL normalization could retarget. */
function buildUrl(plan: OperationPlan, args: Readonly<Record<string, unknown>>): string {
  let url = plan.url
  for (const field of plan.fields) {
    if (field.location !== 'path') continue
    const value = args[field.inputName]
    if (value === undefined) {
      throw argumentError(`missing path parameter "${field.inputName}"`)
    }
    const rendered = serializeSimple(field, value, encodePathSegment)
    if (rendered === '' || rendered === '.' || rendered === '..') {
      throw argumentError(`invalid path parameter "${field.inputName}"`)
    }
    url = url.replaceAll(`{${field.name}}`, rendered)
  }
  const unresolved = /\{[^{}]+\}/u.exec(url)
  if (unresolved !== null) throw argumentError(`unresolved path parameter ${unresolved[0]}`)
  return url
}

/** Percent-encode one path segment, including characters `encodeURIComponent` leaves alone. */
function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replaceAll(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Serialize one query argument into repeated name/value pairs. */
function serializeQuery(field: PlannedField, value: unknown): Array<[string, string]> {
  if (field.style === 'deepObject') {
    if (!isRecordValue(value)) throw argumentError(`deep-object parameter "${field.inputName}" must be an object`)
    return Object.entries(value).flatMap(([name, item]) => {
      if (item === undefined) return []
      return [[`${field.name}[${name}]`, scalarText(field, item)] as [string, string]]
    })
  }
  if (Array.isArray(value)) {
    const items = value.map(item => scalarText(field, item))
    return field.explode
      ? items.map(item => [field.name, item] as [string, string])
      : [[field.name, items.join(',')]]
  }
  if (isRecordValue(value)) {
    const entries = Object.entries(value).flatMap(([name, item]) => (item === undefined ? [] : [[name, item] as const]))
    return field.explode
      ? entries.map(([name, item]) => [name, scalarText(field, item)] as [string, string])
      : [[field.name, entries.flatMap(([name, item]) => [name, scalarText(field, item)]).join(',')]]
  }
  return [[field.name, scalarText(field, value)]]
}

/** Serialize one path or header argument in the OpenAPI `simple` style. */
function serializeSimple(field: PlannedField, value: unknown, encode: (value: string) => string): string {
  if (Array.isArray(value)) return value.map(item => encode(scalarText(field, item))).join(',')
  if (isRecordValue(value)) {
    return Object.entries(value)
      .flatMap(([name, item]) => {
        if (item === undefined) return []
        const rendered = encode(scalarText(field, item))
        return field.explode ? [`${encode(name)}=${rendered}`] : [encode(name), rendered]
      })
      .join(',')
  }
  return encode(scalarText(field, value))
}

/** Render one scalar; nested containers have no defined serialization here. */
function scalarText(field: PlannedField, value: unknown): string {
  if (value === null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw argumentError(`parameter "${field.inputName}" contains an unsupported nested value`)
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a response content type carries JSON. */
function isJsonContentType(value: string | null): boolean {
  const normalized = value?.split(';')[0]?.trim().toLowerCase() ?? ''
  return normalized === 'application/json' || normalized.endsWith('+json')
}

/** Cap text and mark the cut with an ellipsis. */
function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function argumentError(message: string): HarnessError {
  return new HarnessError(`openapi-tools: ${message}`, 'OPENAPI_ARGUMENT_INVALID')
}
