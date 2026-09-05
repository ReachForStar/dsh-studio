/**
 * Translate the Pi AgentSession event stream into dsh session-log events.
 *
 * This is stage 3: the Pi loop still executes, but now its turns, steps,
 * messages, and tool executions are folded into the dsh {@link Session} log so
 * every dsh consumer (subagent, plan, projection, UI) can read a Pi session
 * the same way it reads a dsh one.
 *
 * The translation is deliberately coarse on step boundaries: one Pi turn maps
 * to one dsh turn, and the turn's single model call plus its tools map to one
 * dsh step. Multi-step Pi turns still record every message/tool event in
 * order; only the step split is deferred.
 *
 * @module dsh-pi-agent-loop/pi-event-translator
 */

import {
  AssistantStreamAccumulator,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  TokenUsage,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session'

/** One Pi text/thinking/tool-call event held by a `message_update`. */
interface PiAssistantMessageEvent {
  readonly type: string
  readonly delta?: string
  readonly toolCall?: {
    readonly id: string
    readonly name: string
    readonly arguments?: Record<string, unknown>
  }
}

/** One Pi message, narrowed to the fields the translator maps. */
interface PiMessage {
  readonly role: string
  readonly content?: unknown
  readonly usage?: unknown
  readonly stopReason?: string
}

/** One Pi AgentSession event, narrowed to the fields the translator consumes. */
interface PiEvent {
  readonly type: string
  readonly message?: PiMessage
  readonly assistantMessageEvent?: PiAssistantMessageEvent
  readonly toolCallId?: unknown
  readonly isError?: boolean
  readonly result?: unknown
}

/** Convert one Pi message content block into a dsh content block. */
function convertBlock(block: unknown): ContentBlock | undefined {
  if (block === null || typeof block !== 'object') return undefined
  const record = block as Record<string, unknown>
  if (record.type === 'text' && typeof record.text === 'string') {
    return { type: 'text', text: record.text }
  }
  if (record.type === 'thinking' && typeof record.thinking === 'string') {
    return { type: 'reasoning', text: record.thinking }
  }
  if (record.type === 'toolCall') {
    const id = typeof record.id === 'string' ? record.id : ''
    const name = typeof record.name === 'string' ? record.name : ''
    const args = record.arguments === undefined ? '{}' : JSON.stringify(record.arguments)
    return { type: 'tool-call', id: ToolCallId(id), name, arguments: args }
  }
  return undefined
}

/** Convert a Pi message `content` value into dsh content blocks. */
function convertContent(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const blocks: ContentBlock[] = []
  for (const block of content) {
    const converted = convertBlock(block)
    if (converted !== undefined) blocks.push(converted)
  }
  return blocks
}

/** Convert a Pi assistant usage record into dsh token-usage fields. */
function convertUsage(usage: unknown): TokenUsage | undefined {
  if (usage === null || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  if (typeof record.input !== 'number' || typeof record.output !== 'number') return undefined
  const result: TokenUsage = { inputTokens: record.input, outputTokens: record.output }
  if (typeof record.totalTokens === 'number') result.totalTokens = record.totalTokens
  if (typeof record.cacheRead === 'number') result.cacheReadTokens = record.cacheRead
  if (typeof record.cacheWrite === 'number') result.cacheWriteTokens = record.cacheWrite
  return result
}

/** Map a Pi stop reason to a dsh turn-end reason. */
function turnEndReason(stopReason: string | undefined): TurnEndReason {
  if (stopReason === 'aborted') return { kind: 'aborted', reason: { kind: 'user' } }
  if (stopReason === 'length') return { kind: 'max-tokens' }
  if (stopReason === 'error') {
    return { kind: 'error', error: { message: 'pi turn failed', code: 'PI_ERROR' } }
  }
  return { kind: 'completed' }
}

/**
 * Fold one Pi AgentSession event stream into a dsh Session. Instances track
 * turn/step counters and the in-flight assistant stream; a long-lived instance
 * must not be reused across sessions.
 */
export class PiEventTranslator {
  private turn = 0
  private step = 0
  private stepOpen = false
  private accumulator: AssistantStreamAccumulator | undefined
  private readonly toolCallSeqs = new Map<string, SessionSeq>()

  constructor(private readonly session: Session) {}

  /** Subscribe to a Pi session and route every event into this dsh Session. */
  subscribe(piSession: { subscribe(listener: (event: unknown) => void): () => void }): () => void {
    return piSession.subscribe((event) => { this.handle(event as PiEvent) })
  }

  private handle(event: PiEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.handleTurnStart()
        return
      case 'message_end':
        this.handleMessageEnd(event.message)
        return
      case 'message_update':
        this.handleMessageUpdate(event.assistantMessageEvent)
        return
      case 'tool_execution_end':
        this.handleToolExecutionEnd(event)
        return
      case 'turn_end':
        this.handleTurnEnd(event.message)
        return
      default:
        return
    }
  }

  private handleTurnStart(): void {
    this.turn += 1
    this.step = 0
    this.stepOpen = false
    this.accumulator = undefined
    this.session.append('turn/start', { turn: this.turn })
  }

  private handleMessageEnd(message: PiMessage | undefined): void {
    if (message === undefined) return
    if (message.role === 'user') {
      this.ensureStep()
      const context = createUserMessage({
        content: convertContent(message.content),
        source: { kind: 'user' },
      }) as UserMessage
      this.session.append('user/message', context, { surfaceOp: 'append' })
      return
    }
    // Pi injects `custom` messages (AGENTS.md fragments, hook conventions)
    // into every turn's model context. They are Pi-runtime context, not dsh
    // conversation, so they never enter the dsh log: folding them into
    // `user/message` duplicated on-screen input and bloated the log with the
    // same convention text on every turn.
    if (message.role === 'custom') return
    if (message.role === 'assistant') {
      this.ensureStep()
      const stream = [...(this.accumulator?.snapshot() ?? [])]
      const assistantMessage = createAssistantMessage({
        content: convertContent(message.content),
        source: { provider: '', model: '' },
      })
      const usage = convertUsage(message.usage)
      this.session.append('assistant/message', {
        turn: this.turn,
        step: this.step,
        message: assistantMessage,
        stream,
        ...usage === undefined ? {} : { usage },
      }, { surfaceOp: 'append' })
      this.recordToolCalls(message.content)
    }
  }

  /** Emit dsh `tool/call` events for every tool call on one Pi assistant message. */
  private recordToolCalls(content: unknown): void {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      const record = block as Record<string, unknown>
      if (record.type !== 'toolCall') continue
      const id = typeof record.id === 'string' ? record.id : ''
      const name = typeof record.name === 'string' ? record.name : ''
      const args = record.arguments === undefined ? '{}' : JSON.stringify(record.arguments)
      const event = this.session.append('tool/call', {
        turn: this.turn,
        step: this.step,
        callId: ToolCallId(id),
        name,
        arguments: args,
      })
      this.toolCallSeqs.set(id, event.seq)
    }
  }

  private handleMessageUpdate(event: PiAssistantMessageEvent | undefined): void {
    if (event === undefined) return
    this.ensureStep()
    const time = Date.now()
    if (event.type === 'text_delta' && typeof event.delta === 'string') {
      this.accumulator?.push({ time, chunk: { type: 'text-delta', index: 0, text: event.delta } })
    } else if (event.type === 'thinking_delta' && typeof event.delta === 'string') {
      this.accumulator?.push({ time, chunk: { type: 'reasoning-delta', index: 0, text: event.delta } })
    }
  }

  private handleToolExecutionEnd(event: PiEvent): void {
    this.ensureStep()
    const result = convertToolResult(event)
    if (result === undefined) return
    const sourceSeq = typeof event.toolCallId === 'string' ? this.toolCallSeqs.get(event.toolCallId) : undefined
    if (sourceSeq === undefined) return
    this.session.append('tool/result', {
      turn: this.turn,
      step: this.step,
      message: result,
    }, { surfaceOp: 'append', sourceEventSeqs: [sourceSeq] })
  }

  private handleTurnEnd(message: PiMessage | undefined): void {
    this.closeStep()
    this.session.append('turn/end', { turn: this.turn, reason: turnEndReason(message?.stopReason) })
  }

  private ensureStep(): void {
    if (this.stepOpen) return
    this.step += 1
    this.stepOpen = true
    this.accumulator = new AssistantStreamAccumulator()
    this.session.append('step/start', { turn: this.turn, step: this.step })
  }

  private closeStep(): void {
    if (!this.stepOpen) return
    this.session.append('step/end', { turn: this.turn, step: this.step })
    this.stepOpen = false
    this.accumulator = undefined
  }
}

/** Convert one Pi tool-execution result into a dsh tool-result message. */
function convertToolResult(event: PiEvent): ToolResultMessage | undefined {
  const callId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
  const isError = event.isError === true
  // Pi tool results surface their content under a `content` array; fall back to
  // a bare scalar or an empty text block otherwise.
  const raw = event.result
  const contentValue = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object' && Array.isArray((raw as { content?: unknown }).content)
      ? (raw as { content: unknown[] }).content
      : undefined
  const blocks = convertContent(contentValue)
  return createToolResultMessage({
    callId: ToolCallId(callId),
    content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }],
    isError,
  })
}
