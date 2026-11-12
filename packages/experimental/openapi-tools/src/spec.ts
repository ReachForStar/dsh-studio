/**
 * OpenAPI document loading and operation planning: which operations become
 * tools, which constructs skip an operation, and the exact parameter map each
 * generated tool receives.
 * @module @deepseek-ai/dsh-openapi-tools/spec
 */

import { readFile } from 'node:fs/promises'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { parse as parseYaml } from 'yaml'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { isRecord, nonEmptyString, OPERATION_METHODS, own, resolveReference } from './document.ts'
import { convertSchema, UnsupportedSchemaError } from './schema.ts'

/** Default credential/media-type independent description cap, in characters. */
export const DEFAULT_DESCRIPTION_MAX_LENGTH = 1_024

/** Header parameters the tool never exposes, because transport and auth own them. */
const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization'])

/** Longest tool name a provider surface reliably accepts. */
const TOOL_NAME_LIMIT = 64

/** One OpenAPI operation converted into a callable tool plan. */
export interface OperationPlan {
  /** Model-visible tool name. */
  readonly name: string
  /** Model-visible description: method and path, then the operation text. */
  readonly description: string
  /** Upper-case HTTP method used at execution time. */
  readonly method: string
  /** Path template exactly as the document declares it. */
  readonly path: string
  /** Absolute request URL before path substitution and query serialization. */
  readonly url: string
  /** Compiled parameter map shared by schema and execution. */
  readonly parameters: ParameterSchemaSpec
  /** Per-argument routing and serialization facts. */
  readonly fields: readonly PlannedField[]
  /** Request body facts; absent when the operation declares none. */
  readonly body: PlannedBody | undefined
}

/** One argument of a generated tool, routed to its wire location. */
export interface PlannedField {
  /** Wire name: parameter name, or `body` for the request body. */
  readonly name: string
  /** Argument key the model supplies. */
  readonly inputName: string
  /** Where the argument is sent. */
  readonly location: 'path' | 'query' | 'header' | 'body'
  /** Whether the model must supply it. */
  readonly required: boolean
  /** OpenAPI serialization style. */
  readonly style: 'form' | 'simple' | 'deepObject'
  /** Whether arrays and objects expand into repeated parameters. */
  readonly explode: boolean
  /** Converted DSL schema before the required annotation. */
  readonly schema: ValueSchemaSpec
}

/** Request body facts for one operation. */
export interface PlannedBody {
  /** Argument key carrying the body value. */
  readonly inputName: string
  /** Whether the model must supply a body. */
  readonly required: boolean
  /** JSON media type sent as `content-type`. */
  readonly mediaType: string
}

/** One operation the planner could not expose. */
export interface SkippedOperation {
  /** HTTP method, `WEBHOOK` for document webhooks, or `*` for an unusable path item. */
  readonly method: string
  /** Path template or webhook name. */
  readonly path: string
  /** Why the operation cannot become a tool. */
  readonly reason: string
}

/** Result of planning one document. */
export interface BuildResult {
  /** Operations in document order. */
  readonly operations: readonly OperationPlan[]
  /** Operations and webhooks left out, each with its reason. */
  readonly skipped: readonly SkippedOperation[]
}

/** Planning options shared by every operation in one document. */
export interface BuildOptions {
  /** Absolute base URL; overrides every `servers` entry. */
  readonly baseUrl?: string | undefined
  /** Description cap in characters. */
  readonly descriptionMaxLength: number
}

/**
 * Load and parse an OpenAPI 3.x document.
 * @param source - local path or absolute HTTP(S) URL.
 * @returns the parsed document object.
 * @throws HarnessError when the source is unreadable, unparseable, or not OpenAPI 3.x.
 */
export async function loadDocument(source: string): Promise<Record<string, unknown>> {
  const text = /^https?:\/\//iu.test(source) ? await fetchDocument(source) : await readDocument(source)
  let parsed: unknown
  try {
    // YAML is a JSON superset, so one parser covers both file forms.
    parsed = parseYaml(text)
  } catch (cause) {
    throw new HarnessError(
      `openapi-tools: cannot parse "${source}" as YAML or JSON`,
      'OPENAPI_SPEC_INVALID',
      { cause },
    )
  }
  if (!isRecord(parsed)) {
    throw new HarnessError(`openapi-tools: "${source}" does not contain a document object`, 'OPENAPI_SPEC_INVALID')
  }
  const version = nonEmptyString(own(parsed, 'openapi'))
  if (version === undefined || !version.startsWith('3.')) {
    throw new HarnessError(
      `openapi-tools: "${source}" is not an OpenAPI 3.x document (openapi: ${version ?? 'missing'})`,
      'OPENAPI_SPEC_INVALID',
    )
  }
  return parsed
}

async function readDocument(source: string): Promise<string> {
  try {
    return await readFile(source, 'utf8')
  } catch (cause) {
    throw new HarnessError(`openapi-tools: cannot read "${source}"`, 'OPENAPI_SPEC_LOAD', { cause })
  }
}

async function fetchDocument(source: string): Promise<string> {
  const response = await fetch(source)
  if (!response.ok) {
    throw new HarnessError(
      `openapi-tools: fetching "${source}" failed with HTTP ${String(response.status)}`,
      'OPENAPI_SPEC_LOAD',
    )
  }
  return response.text()
}

/**
 * Plan every representable operation in one document.
 * @param document - parsed OpenAPI 3.x document.
 * @param options - base URL override and description cap.
 * @returns operations to register and operations skipped with reasons.
 */
export function buildOperations(document: Record<string, unknown>, options: BuildOptions): BuildResult {
  const operations: OperationPlan[] = []
  const skipped: SkippedOperation[] = []
  const usedNames = new Set<string>()
  const paths = isRecord(own(document, 'paths')) ? own(document, 'paths') as Record<string, unknown> : {}

  for (const [path, rawPathItem] of Object.entries(paths)) {
    const pathItem = resolveReference(document, rawPathItem)
    if (!isRecord(pathItem)) {
      skipped.push({ method: '*', path, reason: 'path item is not an object' })
      continue
    }
    for (const [rawMethod, rawOperation] of Object.entries(pathItem)) {
      if (!OPERATION_METHODS.has(rawMethod)) continue
      const method = rawMethod.toUpperCase()
      const operation = resolveReference(document, rawOperation)
      if (!isRecord(operation)) {
        skipped.push({ method, path, reason: 'operation is not an object' })
        continue
      }
      try {
        operations.push(planOperation(document, { path, pathItem, method, operation, usedNames, options }))
      } catch (cause) {
        if (!(cause instanceof UnsupportedSchemaError)) throw cause
        skipped.push({ method, path, reason: cause.message })
      }
    }
  }

  const webhooks = own(document, 'webhooks')
  for (const name of Object.keys(isRecord(webhooks) ? webhooks : {})) {
    skipped.push({ method: 'WEBHOOK', path: name, reason: 'webhooks are not supported' })
  }
  return { operations, skipped }
}

/** Inputs for one operation plan. */
interface PlanInput {
  readonly path: string
  readonly pathItem: Record<string, unknown>
  readonly method: string
  readonly operation: Record<string, unknown>
  readonly usedNames: Set<string>
  readonly options: BuildOptions
}

function planOperation(document: Record<string, unknown>, input: PlanInput): OperationPlan {
  const { path, pathItem, method, operation, usedNames, options } = input
  if (own(operation, 'callbacks') !== undefined) {
    throw new UnsupportedSchemaError('operation declares callbacks, which are not supported')
  }
  const baseUrl = validateBaseUrl(options.baseUrl ?? serverUrl(document, pathItem, operation))
  const bodyPlan = planBody(document, operation)
  const fields = assignInputNames([
    ...planParameters(document, pathItem, operation),
    ...bodyPlan === undefined ? [] : [bodyPlan.field],
  ])
  const parameters: ParameterSchemaSpec = {}
  for (const field of fields) {
    parameters[field.inputName] = field.required ? { ...field.schema, required: true } : field.schema
  }
  assertPathParameters(path, fields)
  const bodyField = fields.find(field => field.location === 'body')
  return {
    name: allocateName(usedNames, operation, method, path),
    description: describeOperation(operation, method, path, options.descriptionMaxLength),
    method,
    path,
    url: `${baseUrl.replace(/\/+$/u, '')}${path}`,
    parameters,
    fields,
    body: bodyField === undefined || bodyPlan === undefined
      ? undefined
      : { inputName: bodyField.inputName, required: bodyField.required, mediaType: bodyPlan.mediaType },
  }
}

/** Resolve the first absolute server URL the document, path item, or operation declares. */
function serverUrl(
  document: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): string {
  for (const holder of [operation, pathItem, document]) {
    const servers = own(holder, 'servers')
    if (!Array.isArray(servers)) continue
    const server = servers.find(isRecord)
    const url = server === undefined ? undefined : nonEmptyString(own(server, 'url'))
    if (url === undefined) continue
    if (/\{[^{}]+\}/u.test(url)) {
      throw new UnsupportedSchemaError(`server URL "${url}" uses variables; configure baseUrl instead`)
    }
    return url
  }
  throw new UnsupportedSchemaError('document declares no server URL; configure baseUrl')
}

/** Validate one absolute HTTP(S) base URL. */
function validateBaseUrl(value: string): string {
  const url = URL.parse(value)
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new UnsupportedSchemaError(`base URL "${value}" is not an absolute HTTP(S) URL`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new UnsupportedSchemaError(`base URL "${value}" carries a query string or fragment`)
  }
  return value
}

/** Plan path, query, and header parameters from path-item and operation declarations. */
function planParameters(
  document: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): PlannedField[] {
  // Operation declarations override path-item declarations with the same location and name.
  const declared = new Map<string, Record<string, unknown>>()
  for (const raw of [...arrayOf(own(pathItem, 'parameters')), ...arrayOf(own(operation, 'parameters'))]) {
    const parameter = resolveReference(document, raw)
    if (!isRecord(parameter)) throw new UnsupportedSchemaError('parameter declaration is not an object')
    const name = nonEmptyString(own(parameter, 'name'))
    const location = nonEmptyString(own(parameter, 'in'))
    if (name === undefined || location === undefined) {
      throw new UnsupportedSchemaError('parameter declaration is missing "name" or "in"')
    }
    declared.set(`${location}:${name}`, parameter)
  }

  const fields: PlannedField[] = []
  for (const parameter of declared.values()) {
    const name = nonEmptyString(own(parameter, 'name')) ?? ''
    const location = nonEmptyString(own(parameter, 'in')) ?? ''
    if (location === 'cookie') throw new UnsupportedSchemaError(`cookie parameter "${name}" is not supported`)
    if (location !== 'path' && location !== 'query' && location !== 'header') {
      throw new UnsupportedSchemaError(`parameter "${name}" uses unsupported location "${location}"`)
    }
    if (location === 'header' && IGNORED_HEADERS.has(name.toLowerCase())) continue
    const schema = own(parameter, 'schema')
    if (schema === undefined) {
      throw new UnsupportedSchemaError(`parameter "${name}" declares no schema; content-encoded parameters are not supported`)
    }
    const { style, explode } = parameterSerialization(location, parameter, name)
    fields.push({
      name,
      inputName: name,
      location,
      required: location === 'path' || own(parameter, 'required') === true,
      style,
      explode,
      schema: convertSchema(document, schema, `parameter "${name}"`, nonEmptyString(own(parameter, 'description'))),
    })
  }
  return fields
}

/** Read one parameter's OpenAPI serialization style and explode flag. */
function parameterSerialization(
  location: 'path' | 'query' | 'header',
  parameter: Record<string, unknown>,
  name: string,
): { style: 'form' | 'simple' | 'deepObject'; explode: boolean } {
  const declaredStyle = nonEmptyString(own(parameter, 'style')) ?? (location === 'query' ? 'form' : 'simple')
  if (own(parameter, 'allowReserved') === true) {
    throw new UnsupportedSchemaError(`parameter "${name}" uses unsupported allowReserved encoding`)
  }
  if (location === 'query' && declaredStyle === 'deepObject') {
    if (own(parameter, 'explode') === false) {
      throw new UnsupportedSchemaError(`query parameter "${name}" uses deepObject with explode=false`)
    }
    return { style: 'deepObject', explode: true }
  }
  if (location === 'query' && declaredStyle === 'form') {
    return { style: 'form', explode: own(parameter, 'explode') !== false }
  }
  if (location !== 'query' && declaredStyle === 'simple') {
    return { style: 'simple', explode: own(parameter, 'explode') === true }
  }
  throw new UnsupportedSchemaError(`${location} parameter "${name}" uses unsupported style "${declaredStyle}"`)
}

/** Plan the JSON request body; the model supplies one `body` value. */
function planBody(
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
): { field: PlannedField; mediaType: string } | undefined {
  const declared = resolveReference(document, own(operation, 'requestBody'))
  if (declared === undefined) return undefined
  if (!isRecord(declared)) throw new UnsupportedSchemaError('request body declaration is not an object')
  const content = own(declared, 'content')
  const mediaTypes = Object.keys(isRecord(content) ? content : {})
  if (mediaTypes.length === 0) throw new UnsupportedSchemaError('request body declares no content')
  const mediaType = mediaTypes.find(isJsonMediaType)
  if (mediaType === undefined) {
    throw new UnsupportedSchemaError(`request body media type ${mediaTypes.join(', ')} is not supported; only JSON is`)
  }
  const media = isRecord(content) ? own(content, mediaType) : undefined
  if (!isRecord(media) || own(media, 'schema') === undefined) {
    throw new UnsupportedSchemaError(`request body media type ${mediaType} declares no schema`)
  }
  const description = nonEmptyString(own(declared, 'description')) ?? `JSON request body (${mediaType}).`
  return {
    mediaType,
    field: {
      name: 'body',
      inputName: 'body',
      location: 'body',
      required: own(declared, 'required') === true,
      style: 'simple',
      explode: false,
      schema: convertSchema(document, own(media, 'schema'), 'request body', description),
    },
  }
}

/** Whether a media type carries JSON. */
function isJsonMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  return normalized === 'application/json' || normalized.endsWith('+json')
}

/** Give every field a unique argument key, qualifying same-named wire parameters by location. */
function assignInputNames(fields: readonly PlannedField[]): PlannedField[] {
  const counts = new Map<string, number>()
  for (const field of fields) counts.set(field.name, (counts.get(field.name) ?? 0) + 1)
  const used = new Set<string>()
  return fields.map((field) => {
    const base = (counts.get(field.name) ?? 0) > 1 ? `${field.location}_${field.name}` : field.name
    const inputName = uniqueName(base, used)
    used.add(inputName)
    return { ...field, inputName }
  })
}

/** First unused name among `base`, `base_2`, `base_3`, and so on. */
function uniqueName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base
  for (let index = 2; ; index++) {
    const candidate = `${base}_${String(index)}`
    if (!used.has(candidate)) return candidate
  }
}

/** Reject a path template placeholders that no path parameter fills. */
function assertPathParameters(path: string, fields: readonly PlannedField[]): void {
  const declared = new Set(fields.filter(field => field.location === 'path').map(field => field.name))
  for (const match of path.matchAll(/\{([^{}]+)\}/gu)) {
    const name = match[1] ?? ''
    if (!declared.has(name)) {
      throw new UnsupportedSchemaError(`path parameter "${name}" has no declaration`)
    }
  }
}

/** Allocate a stable tool name from `operationId`, falling back to method and path words. */
function allocateName(
  used: Set<string>,
  operation: Record<string, unknown>,
  method: string,
  path: string,
): string {
  const base = sanitizeToolName(nonEmptyString(own(operation, 'operationId')) ?? fallbackName(method, path))
  const name = uniqueToolName(base, used)
  used.add(name)
  return name
}

/** First unused name among the base and its numeric suffixes, staying within the provider limit. */
function uniqueToolName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base
  for (let index = 2; ; index++) {
    const suffix = `_${String(index)}`
    const candidate = `${base.slice(0, TOOL_NAME_LIMIT - suffix.length)}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/** Reduce a name to the provider-safe tool-name alphabet. */
function sanitizeToolName(raw: string): string {
  const cleaned = raw.replaceAll(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, TOOL_NAME_LIMIT)
  if (cleaned === '') return 'operation'
  return /^[0-9]/u.test(cleaned) ? `_${cleaned.slice(0, TOOL_NAME_LIMIT - 1)}` : cleaned
}

/** Derive `deletePetsByPetId` from `DELETE /pets/{petId}`. */
function fallbackName(method: string, path: string): string {
  const words = [
    method.toLowerCase(),
    ...path.split('/').filter(part => part !== '').flatMap(part =>
      part.startsWith('{') && part.endsWith('}') ? ['by', part.slice(1, -1)] : [part]),
  ].flatMap(part => part.split(/[^A-Za-z0-9]+/u).filter(word => word !== ''))
  return words.map((word, index) =>
    index === 0 ? word.toLowerCase() : `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join('')
}

/** Build the model-visible description: transport line, then summary or description. */
function describeOperation(
  operation: Record<string, unknown>,
  method: string,
  path: string,
  maxLength: number,
): string {
  const text = nonEmptyString(own(operation, 'summary')) ?? nonEmptyString(own(operation, 'description'))
  const header = `${method} ${path}`
  const body = text === undefined ? '' : collapseWhitespace(text)
  return truncate(body === '' ? header : `${header}\n\n${body}`, maxLength)
}

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim()
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
