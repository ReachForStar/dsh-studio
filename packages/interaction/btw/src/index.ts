/**
 * Side questions about one live Session: `POST /api/btw.ask` runs the question
 * in a forked child of the calling Session and returns only its answer. The
 * child inherits the parent's completed-turn context and reports to the caller
 * instead of the parent model, so the main conversation gains no turn.
 * @module @deepseek-ai/dsh-btw
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-subagent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { BTW_ASK_PATH } from './routes.ts'

export { BTW_ASK_PATH, BTW_ASK_ROUTE } from './routes.ts'

/** Side-question policy. */
export interface Config {
  /** Registered subagent provider that inherits the parent's context (default `fork`). */
  provider: string
  /** Longest accepted question in characters. */
  maxQuestionChars: number
  /** Wall-clock budget for one question. */
  timeoutMs: number
}

/** Side-question policy accepted from configuration; every field falls back to its default. */
export interface ConfigInput {
  /** Registered subagent provider that inherits the parent's context (default `fork`). */
  provider?: string
  /** Longest accepted question in characters (default 4000). */
  maxQuestionChars?: number
  /** Wall-clock budget for one question in milliseconds (default 120000). */
  timeoutMs?: number
}

export const Config: z<ConfigInput, Config> = z.object({
  provider: z.string().default('fork'),
  maxQuestionChars: z.natural().min(1).default(4000),
  timeoutMs: z.natural().min(1).default(120_000),
})

export const name = 'btw'
export const inject = ['agents', 'subagents', 'connection']

interface BtwConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly 'POST'[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Register the authenticated side-question route.
 * @param ctx - host context carrying agents, subagents, and the connection route registry.
 * @param config - resolved provider, size, and timeout policy.
 */
export function apply(ctx: Context, config: ConfigInput = {}): void {
  const resolved = Config(config)
  const connection = Reflect.get(ctx, 'connection') as BtwConnection
  connection.fetch.register({
    path: BTW_ASK_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => answerQuestion(ctx, request, resolved),
  })
}

/** Validate one request, run the forked child, and return its answer. */
async function answerQuestion(ctx: Context, request: Request, config: Config): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }
  if (typeof body !== 'object' || body === null) return new Response('invalid body', { status: 400 })
  const { sessionId, question } = body as { sessionId?: unknown; question?: unknown }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return new Response('missing sessionId', { status: 400 })
  }
  if (typeof question !== 'string' || question.trim().length === 0 || question.length > config.maxQuestionChars) {
    return new Response('missing or oversized question', { status: 400 })
  }
  const agent = ctx.agents.get(brandString<SessionId>(sessionId))
  if (agent === undefined) return new Response('session not found', { status: 404 })

  const timeout = new AbortController()
  const timer = setTimeout(() => { timeout.abort() }, config.timeoutMs)
  const signal = AbortSignal.any([request.signal, timeout.signal])
  let activation: SubagentActivation | undefined
  try {
    activation = await ctx.subagents.startActivation({
      provider: config.provider,
      label: 'btw',
      parent: agent,
      prompt: [{ type: 'text', text: question.trim() }],
      signal,
      delivery: 'caller',
    })
    const result = await activation.result
    if (result.stopReason !== 'completed') {
      return new Response('the side question did not complete', { status: 502 })
    }
    return Response.json({ answer: answerText(result.output) })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    if (timeout.signal.aborted) return new Response('the side question timed out', { status: 504 })
    ctx.logger.warn(`btw: ${error instanceof Error ? error.message : String(error)}`)
    return new Response('the side question failed', { status: 500 })
  } finally {
    clearTimeout(timer)
    await activation?.dispose().catch((error: unknown) => {
      ctx.logger.warn(`btw: child disposal failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

/** Join the child's text output; other block kinds are not part of the answer. */
function answerText(output: readonly ContentBlock[]): string {
  return output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}
