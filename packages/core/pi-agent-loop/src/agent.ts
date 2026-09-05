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
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
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
  /** Count of in-flight prompt/steer/follow-up runs; quiescence resolves waiters. */
  private active = 0
  private readonly idleWaiters = new Set<() => void>()

  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    piSession: PiAgentSessionLike,
  ) {
    this.id = id
    this.options = options
    this.session = session
    this.piSession = piSession
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
  }

  get status(): AgentStatus {
    return this.active > 0 || this.piSession.isStreaming ? 'running' : 'idle'
  }

  followup(message: UserMessage): void {
    const text = userText(message)
    void this.run(() => this.piSession.prompt(text))
  }

  steer(message: UserMessage): void {
    const text = userText(message)
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
      runner.registerTool(adaptDshTool(tool as never, runtime as never, this))
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
      if (runtime.get((definition as { name?: string }).name ?? '') !== undefined) continue
      runtime.register(adaptPiTool(definition as never, runner))
    }
  }

  async dispose(): Promise<void> {
    await this.scope.dispose()
  }
}
