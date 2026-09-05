/**
 * A pi-backed Agent driver: dsh owns the session lifecycle and registry, while
 * the Pi coding-agent runtime owns the actual turn execution. This is the
 * stage-2 POC — the Pi loop uses Pi's own tools and model, and does not yet
 * translate Pi events back into the dsh session log (that is stage 3).
 *
 * @module dsh-pi-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { TextBlock } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { PiEventTranslator } from './pi-event-translator.ts'
import { adaptDshTool } from './dsh-tool-adapter.ts'
import { adaptPiTool } from './pi-tool-adapter.ts'

/** The Pi AgentSession surface this driver needs; narrow so tests can supply a stub. */
export interface PiAgentSessionLike {
  readonly isStreaming: boolean
  prompt(text: string): Promise<void>
  steer(text: string): Promise<void>
  followUp(text: string): Promise<void>
  abort(): Promise<void>
  dispose(): void
  /** Subscribe to Pi agent events; returns the unsubscribe function. */
  subscribe(listener: (event: unknown) => void): () => void
  /** Pi's extension runner, when present, for late-registering custom tools. */
  extensionRunner?: {
    registerTool(tool: unknown): void
    getAllRegisteredTools(): Array<{ definition: unknown }>
    createContext(): unknown
  }
}

/** Extract the concatenated visible text of a user message for Pi's prompt. */
function userText(message: UserMessage): string {
  return message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Live agent driven by one Pi AgentSession. Implements the dsh {@link Agent}
 * seam so the registry, cancellation, and idle-wait contracts keep working; the
 * session log is NOT populated with Pi turn/step events yet, so dsh consumers
 * that read the log (subagent, plan, projection) do not observe Pi turns.
 */
/**
 * Durable write surface for one Pi session's dsh log. The PiLoop factory owns
 * the persistence handle; the agent drains every appended batch into it.
 */
export interface PiDurableWrite {
  append(events: readonly SessionEvent[]): Promise<void>
  close(): Promise<void>
}

/**
 * Live agent driven by one Pi AgentSession. Implements the dsh {@link Agent}
 * seam so the registry, cancellation, and idle-wait contracts keep working; the
 * session log is NOT populated with Pi turn/step events yet, so dsh consumers
 * that read the log (subagent, plan, projection) do not observe Pi turns.
 */
export class PiLoopAgent implements Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly inbox: Inbox
  readonly scope: Scope
  readonly ctx: Context

  private readonly piSession: PiAgentSessionLike
  /** Folds the Pi event stream into the dsh session log (stage 3). */
  private readonly translator: PiEventTranslator
  /** Optional durable sink each appended batch drains into. */
  private readonly durable: PiDurableWrite | undefined
  /** Events already acknowledged by the durable sink. */
  private stored = 0
  private flushing: Promise<void> | undefined
  private dirty = false
  /** Count of in-flight prompt/steer/follow-up runs; quiescence resolves waiters. */
  private active = 0
  private readonly idleWaiters = new Set<() => void>()

  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    piSession: PiAgentSessionLike,
    durable?: PiDurableWrite,
    storedCount?: number,
  ) {
    this.id = id
    this.options = options
    this.session = session
    this.piSession = piSession
    this.durable = durable
    this.stored = storedCount ?? 0
    // The inbox is kept for the Agent contract but is unused in this POC: Pi
    // owns pending work through its own prompt/steer queue.
    this.inbox = new Inbox(session, {
      inserted: () => {},
      discarded: () => {},
      claimed: () => {},
    })
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.translator = new PiEventTranslator(session)
    this.translator.subscribe(piSession)
    if (durable !== undefined) {
      this.translator.setOnAppended(() => { this.scheduleFlush() })
    }
  }

  get status(): AgentStatus {
    return this.active > 0 || this.piSession.isStreaming ? 'running' : 'idle'
  }

  followup(message: UserMessage): void {
    const text = userText(message)
    // Carry the dsh request source (its rpcId retires the browser's local
    // submission echo) into the pending Pi user-message translation.
    this.translator.setPendingUserSource(message.source)
    void this.run(() => this.piSession.prompt(text))
  }

  steer(message: UserMessage): void {
    const text = userText(message)
    this.translator.setPendingUserSource(message.source)
    void this.run(() => this.piSession.steer(text))
  }

  inject(_message: UserMessage): void {
    // Pi has no durable context-injection seam in this POC; accept and drop.
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (!wakeup) return
    if (target === 'next-step') this.steer(message)
    else this.followup(message)
  }

  cancel(_cause: AgentCancelCause, _options?: CancelOptions): void {
    this.piSession.abort().catch(() => {
      // Abort after a completed turn is best-effort cleanup.
    })
  }

  whenIdle(): Promise<void> {
    if (this.active === 0 && !this.piSession.isStreaming) return Promise.resolve()
    return new Promise<void>((resolve) => { this.idleWaiters.add(resolve) })
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // Pi has no maintenance phase; run directly so the seam still works.
    return task(new AbortController().signal)
  }

  /** Run one Pi operation, tracking quiescence for {@link whenIdle} and `status`. */
  private async run(operation: () => Promise<void>): Promise<void> {
    this.active += 1
    try {
      await operation()
    } finally {
      this.active -= 1
      if (this.active === 0 && !this.piSession.isStreaming) {
        for (const resolve of this.idleWaiters) resolve()
        this.idleWaiters.clear()
      }
    }
  }

  /**
   * Register this session's dsh tools as Pi custom tools so a Pi turn can call
   * them through the dsh tool pipeline (stage 4 tool sharing).
   */
  registerDshTools(tools: unknown): void {
    const runner = this.piSession.extensionRunner
    if (runner === undefined) return
    const runtime = tools as { schemas(): Array<{ name: string }>; get(name: string): unknown }
    for (const schema of runtime.schemas()) {
      const tool = runtime.get(schema.name)
      if (tool === undefined) continue
      try {
        runner.registerTool(adaptDshTool(tool as never, runtime as never, this))
      } catch (error: unknown) {
        // One unadaptable dsh tool must not block the session from opening.
        this.ctx.logger.warn(`pi agent: failed to register dsh tool "${schema.name}": ${String(error)}`)
      }
    }
  }

  /**
   * Register this session's Pi tools into the dsh tool surface (reverse
   * direction of {@link registerDshTools}).
   */
  registerPiTools(tools: unknown): void {
    const runner = this.piSession.extensionRunner
    if (runner === undefined) return
    const runtime = tools as { register(tool: unknown): void; get(name: string): unknown }
    for (const registered of runner.getAllRegisteredTools()) {
      const definition = registered.definition
      if (definition === undefined) continue
      const name = (definition as { name?: string }).name ?? ''
      if (runtime.get(name) !== undefined) continue
      try {
        runtime.register(adaptPiTool(definition as never, runner))
      } catch (error: unknown) {
        this.ctx.logger.warn(`pi agent: failed to register pi tool "${name}": ${String(error)}`)
      }
    }
  }

  /**
   * Drain every event appended since the last durable acknowledgement.
   * Serialized: a single append batch is in flight at any time and later
   * appends coalesce into the next batch, preserving seq order. Returns once
   * the log is fully acknowledged (no pending and no in-flight flush).
   */
  async flushDurable(): Promise<void> {
    if (this.durable === undefined) return
    // Ensure the current dirty range is being drained, then settle it.
    if (this.flushing === undefined) this.scheduleFlush()
    await this.flushing
    // The drain loop above already ran scheduleFlush's while(dirty) pass; a
    // translator append racing the settle leaves a dirty flag that this final
    // pass acknowledges.
    if (this.dirty) {
      if (this.flushing === undefined) this.scheduleFlush()
      await this.flushing
    }
  }

  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushing !== undefined) return
    this.flushing = (async () => {
      try {
        while (this.dirty) {
          this.dirty = false
          const batch = this.session.snapshotEvents(SessionLogOffset(this.stored))
          if (batch.length > 0) {
            await this.durable?.append(batch)
            this.stored += batch.length
          }
        }
      } finally {
        this.flushing = undefined
      }
    })()
  }

  async dispose(): Promise<void> {
    await this.scope.dispose()
  }
}
