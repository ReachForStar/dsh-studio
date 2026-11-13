/**
 * One-line model summaries of each step's tool batch.
 *
 * The summary is presentation data: it is logged as a latest-wins
 * `tool/batch-summary` event and never enters the model surface. One auxiliary
 * request runs per completed step whose batch holds at least one tool call,
 * bounded by input bytes, output tokens, and a deadline; a failed or disposed
 * request logs nothing and leaves the conversation untouched.
 *
 * @module @deepseek-ai/dsh-step-summary
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, MessageSource } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm/types'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'tool-summary': true
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Auxiliary tool-batch summarization requests this package issues. */
    'tool-summary': { kind: 'tool-summary' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Latest-wins one-line summary of one completed step's tool batch. It is
     * log-only presentation data: it never enters the model surface or derived
     * history.
     */
    'tool/batch-summary': {
      /** Turn whose step batch is summarized. */
      turn: number
      /** Step whose tool batch is summarized. */
      step: number
      /** One-line summary text supplied by the auxiliary model. */
      summary: string
      /** Tool calls in the summarized batch. */
      callCount: number
    }
  }
}

/** Terminal reason code for an auxiliary summary request over deadline. */
export const TOOL_SUMMARY_TIMEOUT_CODE = 'TOOL_SUMMARY_TIMEOUT'

/** Auxiliary summary request defaults: a one-sentence reply fits a small budget. */
export interface Config {
  /** Output-token cap for one summary request. */
  maxOutputTokens: number
  /** End-to-end auxiliary request deadline in milliseconds. */
  timeoutMs: number
  /** Maximum UTF-8 bytes in the prepared batch description. */
  maxInputBytes: number
  /** Maximum characters retained in the accepted summary line. */
  maxSummaryChars: number
  /** Optional explicit provider route; must be paired with `model`. */
  provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  model?: string
}

export const Config: z<Config> = z.object({
  maxOutputTokens: z.number().step(1).min(1).default(64),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
  maxInputBytes: z.number().step(1).min(1).default(16_384),
  maxSummaryChars: z.number().step(1).min(1).default(160),
  provider: z.string(),
  model: z.string(),
})

/** One tool call and its model-facing result within a step batch. */
export interface ToolBatchEntry {
  /** Declared tool name. */
  name: string
  /** Raw model arguments JSON. */
  arguments: string
  /** One-line result excerpt, when the call produced one. */
  result?: string
  /** Whether the call failed. */
  isError?: boolean
}

/**
 * Collect the tool calls and results belonging to one step.
 * @param events - session events to scan, in log order.
 * @param turn - turn owning the step.
 * @param step - step whose batch is collected.
 * @returns one entry per call that has a matching result, in call order.
 */
export function collectToolBatch(
  events: readonly SessionEvent[],
  turn: number,
  step: number,
): ToolBatchEntry[] {
  const entries = new Map<string, ToolBatchEntry>()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.turn === turn && event.data.step === step) {
      const callId = String(event.data.callId)
      if (!entries.has(callId)) {
        entries.set(callId, { name: event.data.name, arguments: event.data.arguments })
      }
      continue
    }
    if (event.type !== 'tool/result' || event.data.turn !== turn || event.data.step !== step) continue
    const callId = String(event.data.message.toolCallId)
    const entry = entries.get(callId)
    if (entry === undefined) continue
    entry.result = resultExcerpt(event.data.message.content)
    if (event.data.message.isError === true) entry.isError = true
  }
  return [...entries.values()]
}

/**
 * Reduce model-facing tool result content to one bounded line.
 * @param content - tool result content blocks.
 * @returns the whitespace-collapsed excerpt, truncated at 200 characters.
 */
export function resultExcerpt(content: unknown): string {
  const blocks = Array.isArray(content) ? content : []
  const texts = blocks.filter((block): block is { type: 'text'; text: string } =>
    typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string')
  const joined = texts.map(block => block.text).join(' ')
  const singleLine = joined.replace(/\s+/gu, ' ').trim()
  return singleLine.length <= 200 ? singleLine : `${singleLine.slice(0, 200)}…`
}

/**
 * Render the batch as the auxiliary request's user input.
 * @param entries - collected batch entries.
 * @param maxInputBytes - UTF-8 byte cap on the rendered input.
 * @returns the framed input text, truncated on whole lines when over the cap.
 */
export function renderBatchInput(entries: readonly ToolBatchEntry[], maxInputBytes: number): string {
  const lines = entries.map((entry) => {
    const call = entry.name + (entry.arguments.length > 0 ? ` ${entry.arguments}` : '')
    const outcome = entry.result === undefined
      ? 'no result'
      : `${entry.isError === true ? 'error: ' : 'result: '}${entry.result}`
    return `- ${call}\n  ${outcome}`
  })
  const input = `Summarize this tool batch in one short sentence, in the language of the user's last request.\n\n${lines.join('\n')}`
  if (Buffer.byteLength(input, 'utf8') <= maxInputBytes) return input
  let truncated = ''
  for (const line of lines) {
    const next = `${truncated === '' ? '' : `${truncated}\n`}${line}`
    if (Buffer.byteLength(next, 'utf8') > maxInputBytes) break
    truncated = next
  }
  return truncated === ''
    ? 'Summarize this tool batch in one short sentence.'
    : `Summarize this tool batch in one short sentence, in the language of the user's last request.\n\n${truncated}`
}

/**
 * Normalize one model reply into a bounded single line.
 * @param text - assembled model output.
 * @param maxSummaryChars - character cap on the accepted line.
 * @returns the trimmed single line, or undefined when the reply is empty.
 */
export function normalizeSummary(text: string, maxSummaryChars: number): string | undefined {
  const singleLine = text.replace(/\s+/gu, ' ').trim()
  if (singleLine.length === 0) return undefined
  return singleLine.length <= maxSummaryChars ? singleLine : `${singleLine.slice(0, maxSummaryChars - 1)}…`
}

/**
 * Request one summary for the current step's batch.
 * @param ctx - context exposing the LLM service.
 * @param session - session whose batch is summarized.
 * @param config - normalized plugin configuration.
 * @param entries - collected batch entries.
 * @param signal - aborts the request.
 * @returns the accepted summary line, or undefined when the reply was empty.
 */
export async function requestSummary(
  ctx: Context,
  session: Session,
  config: Config,
  entries: readonly ToolBatchEntry[],
  signal: AbortSignal,
): Promise<string | undefined> {
  if (config.provider === undefined || config.model === undefined) {
    throw new Error('tool-summary: provider and model must be configured together')
  }
  const input = renderBatchInput(entries, config.maxInputBytes)
  using callDeadline = deadline(signal, config.timeoutMs, TOOL_SUMMARY_TIMEOUT_CODE)
  const maxTokens = config.maxOutputTokens
  const call = await ctx.llm.prepareCall({ provider: config.provider, model: config.model, maxTokens }, callDeadline.signal)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: input }],
    source: { kind: 'tool-summary' } satisfies MessageSource,
  })]
  const assembler = new BlockAssembler()
  for await (const chunk of call.stream({
    ...call.config,
    messages,
    system: 'You summarize an agent\'s tool activity for a user interface. Reply with one sentence and nothing else.',
    sessionId: session.id,
    purpose: 'tool-summary',
    signal: callDeadline.signal,
  })) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  const text = assembler.blocks()
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join(' ')
  return normalizeSummary(text, config.maxSummaryChars)
}

export const name = 'tool-summary'

export const inject = ['llm']

export function apply(ctx: Context, config: Config): void {
  const controllers = new Set<AbortController>()
  // A replayed step/end must not start a second request for the same batch.
  const inFlight = new Set<string>()
  // Batch state accumulates from delivered events; no historical reads are needed.
  const batches = new WeakMap<Session, Map<string, Map<string, ToolBatchEntry>>>()
  ctx.effect(() => () => {
    for (const controller of controllers) controller.abort(new Error('tool-summary disposed'))
    controllers.clear()
  }, 'tool-summary.in-flight')

  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call') {
      const identity = `${String(event.data.turn)}:${String(event.data.step)}`
      const steps = batches.get(session) ?? new Map<string, Map<string, ToolBatchEntry>>()
      batches.set(session, steps)
      const calls = steps.get(identity) ?? new Map<string, ToolBatchEntry>()
      steps.set(identity, calls)
      const callId = String(event.data.callId)
      if (!calls.has(callId)) calls.set(callId, { name: event.data.name, arguments: event.data.arguments })
      return
    }
    if (event.type === 'tool/result') {
      const identity = `${String(event.data.turn)}:${String(event.data.step)}`
      const entry = batches.get(session)?.get(identity)?.get(String(event.data.message.toolCallId))
      if (entry === undefined) return
      entry.result = resultExcerpt(event.data.message.content)
      if (event.data.message.isError === true) entry.isError = true
      return
    }
    if (event.type !== 'step/end') return
    const { turn, step } = event.data
    const identity = `${String(turn)}:${String(step)}`
    if (inFlight.has(identity)) return
    const entries = [...(batches.get(session)?.get(identity)?.values() ?? [])]
    batches.get(session)?.delete(identity)
    if (entries.length === 0) return
    inFlight.add(identity)
    const controller = new AbortController()
    controllers.add(controller)
    void (async () => {
      try {
        const summary = await requestSummary(ctx, session, config, entries, controller.signal)
        if (summary === undefined || controller.signal.aborted) return
        session.append('tool/batch-summary', {
          turn,
          step,
          summary,
          callCount: entries.length,
        })
      } catch (error) {
        ctx.logger.warn(`tool-summary: step ${String(step)} of turn ${String(turn)} produced no summary: ${String(error)}`)
      } finally {
        controllers.delete(controller)
        inFlight.delete(identity)
      }
    })()
  })
}
