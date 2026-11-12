/**
 * Prompt-cache keep-alive for idle Sessions.
 *
 * After a turn ends, the plugin may replay the Session's derived history,
 * recorded tool declarations, and route, append one keep-alive prompt, and send
 * it. The ping shares the conversation's request prefix, so the provider
 * refreshes the cached entry the next real request reads. Pings never enter the
 * Session log or the model-visible history; a failed ping logs one warning and
 * stops warming that Session until its next real request.
 *
 * @module @deepseek-ai/dsh-warming
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason, LlmCallConfig, Message } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm/types'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'warming': true
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Prompt-cache keep-alive requests this package issues. */
    'warming': { kind: 'warming' } & ContextFormed
  }
}

/** Terminal reason code for a keep-alive request over deadline. */
export const WARMING_TIMEOUT_CODE = 'WARMING_TIMEOUT'

/**
 * The keep-alive prompt, verbatim from opencode's warming plugin, so both
 * implementations send identical keep-alive text.
 */
export const KEEP_ALIVE_PROMPT = 'This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK'

/**
 * Interval `auto` resolves to. No LLM adapter reports a prompt-cache TTL
 * (`dsh-llm-pi-ai` exposes only `cacheRetention: 'none' | 'short' | 'long'`), so
 * 90% of a known TTL is unavailable; four minutes stays under the five-minute
 * lifetime most providers keep for a short-retention cache.
 */
export const AUTO_INTERVAL_MS = 4 * 60_000

/** Keep-alive configuration. */
export interface Config {
  /** Whether idle Sessions may be warmed; the package is opt-in by mounting. */
  enabled: boolean
  /** Wait after the latest request before one ping, in milliseconds, or `'auto'`. */
  interval: number | 'auto'
  /** How long after the latest real request warming may continue. */
  durationMs: number
  /** Model-visible keep-alive text. */
  prompt: string
  /** Output-token cap for one ping. */
  maxOutputTokens: number
  /** End-to-end ping deadline in milliseconds. */
  timeoutMs: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  interval: z.union([z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS), z.const('auto')]).default('auto'),
  durationMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30 * 60_000),
  prompt: z.string().default(KEEP_ALIVE_PROMPT),
  maxOutputTokens: z.number().step(1).min(1).default(16),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
})

/** Route of the latest recorded request, reused by keep-alive pings. */
export type WarmRoute = Pick<LlmCallConfig, 'provider' | 'model' | 'reasoningEffort'>

/** Timing shared by scheduling and one ping. */
export interface WarmTiming {
  /** Milliseconds between two pings. */
  intervalMs: number
  /** Milliseconds after the latest real request when warming stops. */
  durationMs: number
}

/**
 * Resolve the configured interval.
 * @param interval - configured number of milliseconds or `'auto'`.
 * @returns the resolved interval in milliseconds.
 */
export function resolveIntervalMs(interval: number | 'auto'): number {
  return interval === 'auto' ? AUTO_INTERVAL_MS : interval
}

/**
 * Whether another ping fits before the warming window closes. Pinging at the
 * window edge would only recreate a cache entry nothing reads afterwards.
 * @param lastSendAt - send time of the latest request or ping.
 * @param lastRequestAt - send time of the Session's latest real request.
 * @param timing - resolved interval and duration.
 * @returns whether the next ping is due before the window closes.
 */
export function pingFitsWindow(lastSendAt: number, lastRequestAt: number, timing: WarmTiming): boolean {
  return lastSendAt + timing.intervalMs < lastRequestAt + timing.durationMs
}

/**
 * Route the recorded request used. An effort materialized from adapter defaults
 * is omitted so the ping inherits the same default as the conversation.
 * @param config - the recorded request's call configuration.
 * @param adapterDefaulted - whether the adapter supplied the effort.
 * @returns the provider/model route with an explicit effort when one applies.
 */
export function routeOf(config: LlmCallConfig, adapterDefaulted: boolean | undefined): WarmRoute {
  return {
    provider: config.provider,
    model: config.model,
    ...adapterDefaulted === true || config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: config.reasoningEffort },
  }
}

/**
 * Send one keep-alive request. The call replays the Session's derived history,
 * recorded tool declarations, and recorded route, then appends the keep-alive
 * prompt; it reuses the conversation's cached prefix without appending any
 * Session event.
 * @param ctx - context exposing the LLM service.
 * @param session - Session whose history and recorded header the ping reuses.
 * @param config - normalized plugin configuration.
 * @param signal - aborts the request.
 * @throws when no request header was recorded, the route cannot be prepared,
 *   the deadline elapses, or the provider reports a failed or aborted finish.
 */
export async function requestKeepAlive(
  ctx: Context,
  session: Session,
  config: Config,
  signal: AbortSignal,
): Promise<void> {
  const header = session.requestHeader()
  if (header === undefined) throw new Error('warming: no recorded request header to reuse')
  const route = routeOf(header.config, header.adapterDefaults?.reasoningEffort)
  using callDeadline = deadline(signal, config.timeoutMs, WARMING_TIMEOUT_CODE)
  const call = await ctx.llm.prepareCall({ ...route, maxTokens: config.maxOutputTokens }, callDeadline.signal)
  // The prefix is the conversation as the next request would send it; the
  // prompt is the only novel input, mirroring opencode's session.generate.
  const messages: Message[] = [
    ...session.deriveMessages(),
    createUserMessage({ content: [{ type: 'text', text: config.prompt }], source: { kind: 'warming' } }),
  ]
  let finish: FinishReason | undefined
  for await (const chunk of call.stream({
    ...call.config,
    messages,
    toolHistory: session.toolHistory(),
    ...header.tools === undefined ? {} : { tools: [...header.tools] },
    sessionId: session.id,
    purpose: 'warming',
    signal: callDeadline.signal,
  })) {
    callDeadline.signal.throwIfAborted()
    if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    throw new Error(`warming: keep-alive request finished with ${finish.kind}`)
  }
}

/** Per-Session timing this process observed. */
interface WarmState {
  /** Send time of the latest real request; the warming window starts here. */
  lastRequestAt: number
  /** Send time of the latest real request or ping; the next interval starts here. */
  lastSendAt: number
  /** Pending ping timer; `undefined` when none is scheduled. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** Set after one failed ping; a later real request clears it. */
  stopped: boolean
  /** In-flight ping, aborted when real work starts or the plugin is disposed. */
  controller: AbortController | undefined
}

export const name = 'warming'

export const inject = ['llm']

export function apply(ctx: Context, config: Config): void {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const controllers = new Set<AbortController>()
  // Weak keys keep state for Sessions this process stopped using collectable.
  const states = new WeakMap<Session, WarmState>()

  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const controller of controllers) controller.abort(new Error('warming disposed'))
    controllers.clear()
  }, 'warming.timers')

  const stateOf = (session: Session): WarmState => {
    const existing = states.get(session)
    if (existing !== undefined) return existing
    const created: WarmState = { lastRequestAt: 0, lastSendAt: 0, timer: undefined, stopped: false, controller: undefined }
    states.set(session, created)
    return created
  }

  const cancel = (state: WarmState): void => {
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      timers.delete(state.timer)
      state.timer = undefined
    }
    // A new turn must not compete with a ping still queued at the provider.
    state.controller?.abort(new Error('warming superseded by real work'))
  }

  const send = async (session: Session, state: WarmState): Promise<void> => {
    if (state.stopped || session.requestHeader() === undefined || !config.enabled) return
    const timing: WarmTiming = { intervalMs: resolveIntervalMs(config.interval), durationMs: config.durationMs }
    if (!pingFitsWindow(state.lastSendAt, state.lastRequestAt, timing)) return
    const controller = new AbortController()
    controllers.add(controller)
    state.controller = controller
    try {
      await requestKeepAlive(ctx, session, config, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return
      state.stopped = true
      ctx.logger.warn(`warming: session ${session.id} stopped warming after a failed keep-alive: ${String(error)}`)
      return
    } finally {
      controllers.delete(controller)
      if (state.controller === controller) state.controller = undefined
    }
    state.lastSendAt = Date.now()
    schedule(session, state)
  }

  const schedule = (session: Session, state: WarmState): void => {
    if (state.timer !== undefined || state.stopped || session.requestHeader() === undefined || !config.enabled) return
    const timing: WarmTiming = { intervalMs: resolveIntervalMs(config.interval), durationMs: config.durationMs }
    if (!pingFitsWindow(state.lastSendAt, state.lastRequestAt, timing)) return
    const delay = Math.max(0, state.lastSendAt + timing.intervalMs - Date.now())
    const timer = setTimeout(() => {
      timers.delete(timer)
      state.timer = undefined
      void send(session, state)
    }, delay)
    timers.add(timer)
    state.timer = timer
  }

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (event.type === 'request/header') {
      const state = stateOf(session)
      cancel(state)
      state.stopped = false
      state.lastRequestAt = Date.now()
      state.lastSendAt = state.lastRequestAt
      return
    }
    if (event.type === 'step/start' || event.type === 'turn/start') {
      // Real work supersedes a pending ping and re-enables a failed Session.
      const state = stateOf(session)
      cancel(state)
      state.stopped = false
      if (event.type === 'step/start') {
        state.lastRequestAt = Date.now()
        state.lastSendAt = state.lastRequestAt
      }
      return
    }
    if (event.type === 'turn/end') schedule(session, stateOf(session))
  })
}
