import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionAssistantStreamFrame,
  SessionController,
  SessionFollowFrame,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller'
import type { A2AExecutor, A2AExecutorContext, A2AStreamSink } from '@reachforstar/dsh-a2a'

/** Default bound on one turn, so a peer request cannot wait forever. */
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000

/** Artifact identity and name the reply text streams into. */
const REPLY_ARTIFACT_ID = 'reply'

/** Executor configuration. */
export interface DshA2AExecutorOptions {
  /** The Session surface peer messages drive. */
  readonly sessions: SessionController
  /** Working directory sessions start in; the host default when absent. */
  readonly cwd?: string
  /** Agent preset sessions are created with; the deployment default when absent. */
  readonly agentPreset?: string
  /** How long one turn may run before the task fails. */
  readonly turnTimeoutMs?: number
  /** Where background failures are reported. */
  readonly onError?: (message: string, error: unknown) => void
}

/** One JSON object view of a wire value, or undefined when it is not an object. */
function asObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : undefined
}

/**
 * The prompt identity a durable user message carries, when it carries one.
 * @param data - the event payload as the wire carried it.
 * @returns the request id, or undefined for a message no client prompt produced.
 */
function requestIdOf(data: JsonValue): string | undefined {
  const source = asObject(asObject(data)?.source)
  return typeof source?.rpcId === 'string' ? source.rpcId : undefined
}

/**
 * Text of a durable `assistant/message` payload, read from its text content
 * blocks. This is a wire boundary, so the payload is inspected rather than
 * assumed.
 * @param data - the event payload as the wire carried it.
 * @returns the message's text content, empty when it carried none.
 */
export function assistantText(data: JsonValue): string {
  const content = asObject(asObject(data)?.message)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => asObject(block))
    .flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('')
}

/**
 * Text one assistant stream frame carries, read from its text-delta chunks.
 * @param frame - the frame as the wire carried it.
 * @returns the delta text, empty for every other frame kind.
 */
export function streamText(frame: SessionAssistantStreamFrame): string {
  if (frame.type !== 'chunk') return ''
  const chunk = asObject(frame.chunk)
  return chunk?.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : ''
}

/** Executes A2A tasks against dsh Sessions. */
export class DshA2AExecutor implements A2AExecutor {
  /** Cancellation of the turn each running task drives, by A2A task id. */
  private readonly running = new Map<string, AbortController>()

  /**
   * @param options - the session surface and the session's deployment facts.
   */
  constructor(private readonly options: DshA2AExecutorOptions) {}

  /**
   * Run one peer message as one dsh turn, streaming the reply into the task's
   * artifact.
   * @param context - the task to execute and the sink to report through.
   */
  async onMessage(context: A2AExecutorContext): Promise<void> {
    const sessionId = SessionId(context.contextId)
    await this.options.sessions.create({
      sessionId,
      ...this.options.cwd === undefined ? {} : { cwd: this.options.cwd },
      ...this.options.agentPreset === undefined ? {} : { agentPreset: this.options.agentPreset },
    })

    const cancellation = new AbortController()
    // 盒子持有标志：定时器回调的赋值不受外层控制流收窄影响。
    const deadline = { reached: false }
    const timeout = setTimeout(() => {
      deadline.reached = true
      cancellation.abort()
    }, this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)
    timeout.unref()
    this.running.set(context.taskId, cancellation)

    // The client-minted identity is what tells this task's user message apart
    // from another client's: the durable event carries it as `source.rpcId`.
    const requestId = brandString<SessionRequestId>(randomUUID())
    // Subscribe before prompting: the opening snapshot plus the frames that
    // follow are gap-free, so the turn this prompt starts cannot be missed.
    const frames = this.options.sessions.follow(
      { address: { kind: 'session', sessionId }, assistantStream: true },
      cancellation.signal,
    )
    try {
      context.sink.sendStatus('TASK_STATE_WORKING')
      await this.options.sessions.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: context.text }],
      }, cancellation.signal)
      await this.consume(frames, context.sink, requestId)
    } catch (error) {
      if (deadline.reached) {
        throw new Error(`A2A task ${context.taskId} exceeded its ${String(this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)}ms turn budget`, { cause: error })
      }
      throw error
    } finally {
      clearTimeout(timeout)
      this.running.delete(context.taskId)
    }
  }

  /**
   * Stop the turn behind a canceled task: the peer's cancellation reaches the
   * session, so the agent stops working rather than finishing unread.
   * @param context - identities of the canceled task.
   */
  onCancel(context: { taskId: string; contextId: string }): void {
    this.running.get(context.taskId)?.abort()
    this.options.sessions.cancel({ sessionId: SessionId(context.contextId) })
  }

  /**
   * Follow one session turn to its end, streaming reply text into the artifact.
   *
   * Only the turn this task started is consumed: another client driving the
   * same session concurrently produces its own user message and turn end,
   * whose text and terminal event belong to that client's request. The turn is
   * recognised by the prompt identity carried on the durable user message.
   * @param frames - the session stream, opened before the prompt was admitted.
   * @param sink - the task's progress sink.
   * @param requestId - the identity this task's prompt was admitted with.
   */
  private async consume(
    frames: AsyncIterable<SessionFollowFrame>,
    sink: A2AStreamSink,
    requestId: SessionRequestId,
  ): Promise<void> {
    let started = false
    let streamed = ''
    let settled = ''
    for await (const frame of frames) {
      if (frame.type === 'assistant-stream') {
        if (!started) continue
        const text = streamText(frame.frame)
        if (text.length === 0) continue
        streamed += text
        sink.appendArtifact(REPLY_ARTIFACT_ID, REPLY_ARTIFACT_ID, text)
        continue
      }
      if (frame.type !== 'event') continue
      if (frame.event.type === 'user/message') {
        started = requestIdOf(frame.event.data) === requestId
        continue
      }
      if (frame.event.type === 'assistant/message') {
        if (started) settled = assistantText(frame.event.data)
        continue
      }
      if (frame.event.type === 'turn/end' && started) break
    }
    // A turn that produced no stream frames — a tool-only turn, or a backend
    // that does not stream — still has a committed assistant message.
    if (streamed.length === 0 && settled.length > 0) {
      sink.appendArtifact(REPLY_ARTIFACT_ID, REPLY_ARTIFACT_ID, settled, true)
    }
  }
}
