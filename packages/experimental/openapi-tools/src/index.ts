/**
 * OpenAPI 3.x tools. One configured document becomes a set of model-visible
 * tools, one per representable operation; authentication stays host-side and
 * never appears in a tool schema. Operations the value-schema DSL cannot
 * express are skipped with a logged reason.
 * @module @deepseek-ai/dsh-openapi-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { invoke } from './runtime.ts'
import type { AuthSetting } from './runtime.ts'
import { buildOperations, DEFAULT_DESCRIPTION_MAX_LENGTH, loadDocument } from './spec.ts'
import type { OperationPlan, SkippedOperation } from './spec.ts'

export const name = 'openapi-tools'
export const inject = ['tools']

/** Default request deadline. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Default cap on a returned non-JSON body. */
const DEFAULT_MAX_RESPONSE_CHARS = 20_000

/** Default cap on the body quoted inside an HTTP failure message. */
const DEFAULT_MAX_ERROR_BODY_CHARS = 1_000

/** `spec` value form that resolves through `ctx.credentials`. */
const CREDENTIAL_REFERENCE = /^\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}$/u

/** Host-side authentication for every request of one document. */
export interface AuthConfig {
  /** `${credential:NAME}` reference or bare environment-variable name. */
  credential: string
  /** Where the resolved secret is sent; default `bearer`. */
  scheme?: 'bearer' | 'header' | 'query'
  /** Header or query parameter name required by `header` and `query`. */
  name?: string
}

/** OpenAPI tools plugin configuration. */
export interface Config {
  /** Local path or absolute HTTP(S) URL of the OpenAPI 3.x document. */
  spec: string
  /** Absolute base URL; overrides every `servers` entry in the document. */
  baseUrl?: string
  /** Static headers sent on every request. */
  headers?: Record<string, string>
  /** Optional host-side authentication; omitted means anonymous requests. */
  auth?: AuthConfig
  /** Request deadline in milliseconds. */
  timeoutMs?: number
  /** Cap on a returned non-JSON body, in characters. */
  maxResponseChars?: number
  /** Cap on the body quoted inside an HTTP failure, in characters. */
  maxErrorBodyChars?: number
  /** Cap on each generated tool description, in characters. */
  descriptionMaxLength?: number
}

/** Schemastery configuration for the OpenAPI tools plugin. */
export const Config: z<Config> = z.object({
  spec: z.string().required(),
  baseUrl: z.string(),
  headers: z.dict(z.string()).default({}),
  auth: z.object({
    credential: z.string().required(),
    scheme: z.union([z.const('bearer'), z.const('header'), z.const('query')]).default('bearer'),
    name: z.string(),
  }),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxResponseChars: z.number().default(DEFAULT_MAX_RESPONSE_CHARS),
  maxErrorBodyChars: z.number().default(DEFAULT_MAX_ERROR_BODY_CHARS),
  descriptionMaxLength: z.number().default(DEFAULT_DESCRIPTION_MAX_LENGTH),
})

/** Direct-call options for {@link buildTools}; every field is optional. */
export interface BuildToolOptions {
  /** Absolute base URL; overrides every `servers` entry. */
  baseUrl?: string | undefined
  /** Static headers sent on every request. */
  headers?: Readonly<Record<string, string>> | undefined
  /** Optional host-side authentication. */
  auth?: AuthSetting | undefined
  /** Request deadline in milliseconds. */
  timeoutMs?: number | undefined
  /** Cap on a returned non-JSON body, in characters. */
  maxResponseChars?: number | undefined
  /** Cap on the body quoted inside an HTTP failure, in characters. */
  maxErrorBodyChars?: number | undefined
  /** Cap on each generated tool description, in characters. */
  descriptionMaxLength?: number | undefined
}

/** Resolved limits shared by every tool of one document. */
interface ToolLimits {
  readonly headers: Readonly<Record<string, string>>
  readonly auth: AuthSetting | undefined
  readonly timeoutMs: number
  readonly maxResponseChars: number
  readonly maxErrorBodyChars: number
  readonly descriptionMaxLength: number
}

/**
 * Turn one document into model-visible tools.
 * @param document - parsed OpenAPI 3.x document.
 * @param options - base URL, static headers, authentication, and limits.
 * @returns generated tools and the skipped operations with their reasons.
 * @throws when a numeric limit is not a positive integer.
 */
export function buildTools(
  document: Record<string, unknown>,
  options: BuildToolOptions = {},
): { tools: ToolDefinition[]; skipped: readonly SkippedOperation[] } {
  const limits: ToolLimits = {
    headers: options.headers ?? {},
    auth: options.auth,
    timeoutMs: positiveInteger('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    maxResponseChars: positiveInteger('maxResponseChars', options.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS),
    maxErrorBodyChars: positiveInteger('maxErrorBodyChars', options.maxErrorBodyChars ?? DEFAULT_MAX_ERROR_BODY_CHARS),
    descriptionMaxLength: positiveInteger(
      'descriptionMaxLength',
      options.descriptionMaxLength ?? DEFAULT_DESCRIPTION_MAX_LENGTH,
    ),
  }
  const { operations, skipped } = buildOperations(document, {
    baseUrl: options.baseUrl,
    descriptionMaxLength: limits.descriptionMaxLength,
  })
  return { tools: operations.map(operation => createOperationTool(operation, limits)), skipped }
}

/** Build one model-visible tool from a planned operation. */
function createOperationTool(plan: OperationPlan, limits: ToolLimits): ToolDefinition {
  return defineTool({
    name: plan.name,
    description: plan.description,
    parameters: plan.parameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: truncate(renderValue(value), limits.maxResponseChars),
      }],
    },
    execute: (args, exec) => invoke(plan, args, {
      headers: limits.headers,
      auth: limits.auth,
      timeoutMs: limits.timeoutMs,
      maxResponseChars: limits.maxResponseChars,
      maxErrorBodyChars: limits.maxErrorBodyChars,
      signal: exec.signal,
    }),
  })
}

/** Render a canonical JSON value as model-facing text. */
function renderValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Cap text and mark the cut with an ellipsis. */
function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

/**
 * Load the configured document and register one tool per representable operation.
 * @param ctx - context carrying `ctx.tools`.
 * @param config - document location, transport settings, and credential.
 * @throws HarnessError when the document cannot be read or parsed.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const settings = resolveSettings(config)
  const document = await loadDocument(settings.spec)
  const auth = settings.auth
  const { tools, skipped } = buildTools(document, {
    baseUrl: settings.baseUrl,
    headers: settings.headers,
    timeoutMs: settings.timeoutMs,
    maxResponseChars: settings.maxResponseChars,
    maxErrorBodyChars: settings.maxErrorBodyChars,
    descriptionMaxLength: settings.descriptionMaxLength,
    auth: auth === undefined ? undefined : {
      scheme: auth.scheme,
      name: auth.name,
      resolve: () => readCredential(ctx, auth.reference),
    },
  })
  for (const item of skipped) {
    ctx.logger.warn(`openapi-tools: skipped ${item.method} ${item.path}: ${item.reason}`)
  }
  if (tools.length === 0) {
    ctx.logger.warn(`openapi-tools: "${settings.spec}" exposes no representable operation`)
    return
  }
  for (const tool of tools) ctx.tools.register(tool)
}

/** Fully resolved plugin settings, defaults and credential name applied. */
interface ResolvedSettings {
  readonly spec: string
  readonly baseUrl: string | undefined
  readonly headers: Readonly<Record<string, string>>
  readonly auth: { readonly scheme: 'bearer' | 'header' | 'query'; readonly name?: string; readonly reference: string } | undefined
  readonly timeoutMs: number
  readonly maxResponseChars: number
  readonly maxErrorBodyChars: number
  readonly descriptionMaxLength: number
}

/** Apply defaults and validate every configurable limit. */
function resolveSettings(config: Config): ResolvedSettings {
  const scheme = config.auth?.scheme ?? 'bearer'
  const authName = nonEmpty(config.auth?.name)
  if (config.auth !== undefined && scheme !== 'bearer' && authName === undefined) {
    throw new Error(`openapi-tools: auth.scheme "${scheme}" requires auth.name`)
  }
  return {
    spec: config.spec,
    baseUrl: nonEmpty(config.baseUrl),
    headers: config.headers ?? {},
    auth: config.auth === undefined ? undefined : {
      scheme,
      ...authName === undefined ? {} : { name: authName },
      reference: credentialName(config.auth.credential),
    },
    timeoutMs: positiveInteger('timeoutMs', config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    maxResponseChars: positiveInteger('maxResponseChars', config.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS),
    maxErrorBodyChars: positiveInteger('maxErrorBodyChars', config.maxErrorBodyChars ?? DEFAULT_MAX_ERROR_BODY_CHARS),
    descriptionMaxLength: positiveInteger(
      'descriptionMaxLength',
      config.descriptionMaxLength ?? DEFAULT_DESCRIPTION_MAX_LENGTH,
    ),
  }
}

/** Read the current credential value through the optional seam, then the process environment. */
async function readCredential(ctx: Context, reference: string): Promise<string | undefined> {
  const resolved = await ctx.get('credentials')?.resolve(credentialRef(reference))
  return resolved?.value ?? process.env[reference]
}

/**
 * Extract the reference name from a `${credential:NAME}` value or a bare environment-variable name.
 * @param value - configured credential value.
 * @returns the validated reference name.
 * @throws when the value names no valid reference.
 */
export function credentialName(value: string): string {
  const name = CREDENTIAL_REFERENCE.exec(value)?.[1] ?? value
  if (!isCredentialRefName(name)) {
    throw new Error('openapi-tools: auth.credential must be "${credential:NAME}" or an environment-variable name')
  }
  return name
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

function positiveInteger(field: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`openapi-tools: "${field}" must be a positive integer, received ${String(value)}`)
  }
  return value
}
