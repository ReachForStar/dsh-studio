/**
 * Model-suggested next steps for the user after a completed turn.
 *
 * Suggestions are presentation data: they are logged as a latest-wins
 * `followup/suggestions` event and never enter the model surface. One auxiliary
 * request runs per completed turn whose last request and reply are available,
 * bounded by input bytes, output tokens, and a deadline; a failed or disposed
 * request logs nothing and leaves the conversation untouched.
 *
 * @module @deepseek-ai/dsh-followup
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm/types'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'followup': true
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Auxiliary next-step suggestion requests this package issues. */
    'followup': { kind: 'followup' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Latest-wins next-step suggestions for one completed turn. It is log-only
     * presentation data: it never enters the model surface or derived history.
     */
    'followup/suggestions': {
      /** Turn whose completion produced the suggestions. */
      turn: number
      /** Concrete next actions the user can pick, in suggested order. */
      suggestions: string[]
    }
  }
}

/** Terminal reason code for an auxiliary suggestion request over deadline. */
export const FOLLOWUP_TIMEOUT_CODE = 'FOLLOWUP_TIMEOUT'

/** Auxiliary suggestion request configuration. */
export interface Config {
  /** Output-token cap for one suggestion request. */
  maxOutputTokens: number
  /** End-to-end auxiliary request deadline in milliseconds. */
  timeoutMs: number
  /** Maximum UTF-8 bytes in the prepared conversation excerpt. */
  maxInputBytes: number
  /** Maximum accepted suggestions per turn. */
  maxSuggestions: number
  /** Maximum characters in one accepted suggestion. */
  maxSuggestionChars: number
  /** Optional explicit provider route; must be paired with `model`. */
  provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  model?: string
}

export const Config: z<Config> = z.object({
  maxOutputTokens: z.number().step(1).min(1).default(256),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
  maxInputBytes: z.number().step(1).min(1).default(8_192),
  maxSuggestions: z.number().step(1).min(1).default(3),
  maxSuggestionChars: z.number().step(1).min(1).default(120),
  provider: z.string(),
  model: z.string(),
})

/** One turn's model-facing conversation excerpt used to suggest next steps. */
export interface TurnExcerpt {
  /** Harness-visible user request text, when the turn carried one. */
  request?: string
  /** Last assistant reply text of the turn, when one was streamed. */
  reply?: string
}

/**
 * Render the excerpt as the auxiliary request's user input.
 * @param excerpt - collected turn text.
 * @param maxInputBytes - UTF-8 byte cap on the rendered input.
 * @returns the framed input text, truncated per section when over the cap.
 */
export function renderSuggestionInput(excerpt: TurnExcerpt, maxInputBytes: number): string {
  const sections: string[] = []
  if (excerpt.request !== undefined) sections.push(`User's last request:\n${excerpt.request}`)
  if (excerpt.reply !== undefined) sections.push(`Assistant's last reply:\n${excerpt.reply}`)
  const header = 'Suggest the next concrete actions the user most likely wants to take, '
    + 'given this exchange. Return one short imperative action per line, no numbering, no commentary.'
  const framed = sections.length === 0 ? header : `${header}\n\n${sections.join('\n\n')}`
  return boundUtf8(framed, maxInputBytes)
}

/**
 * Bound text to a UTF-8 byte budget without splitting a code point.
 * @param text - text to bound.
 * @param maxBytes - byte cap.
 * @returns the original text when it fits, otherwise a code-point-safe prefix.
 */
export function boundUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '')
}

/**
 * Parse model output into at most `maxSuggestions` bounded single-line actions.
 * @param text - assembled model output.
 * @param config - normalized configuration providing the caps.
 * @returns accepted suggestions in model order; empty when none survive.
 */
export function parseSuggestions(text: string, config: Config): string[] {
  const lines = text.split('\n')
    .map(line => line.trim())
    .map(line => line.replace(/^(?:[-*•]|\d+[.)])\s+/u, ''))
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line.length <= config.maxSuggestionChars
      ? line
      : `${line.slice(0, config.maxSuggestionChars - 1)}…`)
  return lines.slice(0, config.maxSuggestions)
}


/**
 * Accumulate one turn's request and reply text from delivered events.
 * @param state - per-session accumulator.
 * @param currentTurn - turn opened by the last delivered `turn/start`, if any.
 * @param event - the delivered event.
 * @returns whether the event contributed conversation text.
 */
export function accumulateTurn(
  state: Map<number, TurnExcerpt>,
  currentTurn: number | undefined,
  event: SessionEvent,
): boolean {
  if (event.type === 'user/message') {
    if (currentTurn === undefined) return false
    const turn = currentTurn
    const text = event.data.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join(' ')
      .trim()
    if (text.length === 0) return false
    const excerpt = state.get(turn) ?? {}
    excerpt.request = excerpt.request === undefined ? text : `${excerpt.request}\n${text}`
    state.set(turn, excerpt)
    return true
  }
  if (event.type === 'assistant/message') {
    const turn = event.data.turn
    const text = event.data.message.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join(' ')
      .trim()
    if (text.length === 0) return false
    const excerpt = state.get(turn) ?? {}
    excerpt.reply = text
    state.set(turn, excerpt)
    return true
  }
  return false
}

/**
 * Request next-step suggestions for one completed turn.
 * @param ctx - context exposing the LLM service.
 * @param session - session whose turn completed.
 * @param config - normalized plugin configuration.
 * @param excerpt - accumulated turn text.
 * @param signal - aborts the request.
 * @returns accepted suggestions; empty when the reply held none.
 */
export async function requestSuggestions(
  ctx: Context,
  session: Session,
  config: Config,
  excerpt: TurnExcerpt,
  signal: AbortSignal,
): Promise<string[]> {
  if (config.provider === undefined || config.model === undefined) {
    throw new Error('followup: provider and model must be configured together')
  }
  const input = renderSuggestionInput(excerpt, config.maxInputBytes)
  using callDeadline = deadline(signal, config.timeoutMs, FOLLOWUP_TIMEOUT_CODE)
  const maxTokens = config.maxOutputTokens
  const call = await ctx.llm.prepareCall({ provider: config.provider, model: config.model, maxTokens }, callDeadline.signal)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: input }],
    source: { kind: 'followup' },
  })]
  const assembler = new BlockAssembler()
  for await (const chunk of call.stream({
    ...call.config,
    messages,
    system: 'You propose concrete next actions for a software agent harness user. Reply with plain lines only.',
    sessionId: session.id,
    purpose: 'followup',
    signal: callDeadline.signal,
  })) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  const text = assembler.blocks()
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
  return parseSuggestions(text, config)
}

export const name = 'followup'

export const inject = ['llm']

export function apply(ctx: Context, config: Config): void {
  const controllers = new Set<AbortController>()
  // A replayed turn/end must not start a second request for the same turn.
  const inFlight = new Set<string>()
  // Turn text accumulates from delivered events; no historical reads are needed.
  const turns = new WeakMap<Session, Map<number, TurnExcerpt>>()
  const openTurns = new WeakMap<Session, number>()

  ctx.effect(() => () => {
    for (const controller of controllers) controller.abort(new Error('followup disposed'))
    controllers.clear()
  }, 'followup.in-flight')

  ctx.on('session/event', (session, event) => {
    const state = turns.get(session) ?? new Map<number, TurnExcerpt>()
    turns.set(session, state)
    if (event.type === 'turn/start') {
      openTurns.set(session, event.data.turn)
      return
    }
    if (accumulateTurn(state, openTurns.get(session), event)) return
    if (event.type !== 'turn/end') return
    const turn = event.data.turn
    const identity = String(turn)
    if (inFlight.has(identity)) return
    const excerpt = state.get(turn)
    state.delete(turn)
    if (excerpt === undefined) return
    inFlight.add(identity)
    const controller = new AbortController()
    controllers.add(controller)
    void (async () => {
      try {
        const suggestions = await requestSuggestions(ctx, session, config, excerpt, controller.signal)
        if (suggestions.length === 0 || controller.signal.aborted) return
        session.append('followup/suggestions', { turn, suggestions })
      } catch (error) {
        ctx.logger.warn(`followup: turn ${String(turn)} produced no suggestions: ${String(error)}`)
      } finally {
        controllers.delete(controller)
        inFlight.delete(identity)
      }
    })()
  })
}
