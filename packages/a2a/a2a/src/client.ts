import { randomUUID } from 'node:crypto'
import { A2A_PROTOCOL_VERSION } from './schema.ts'
import type { A2ATaskRow } from './task-store.ts'
import type {
  A2AStreamEvent,
  A2ATask,
  AgentCard,
  SendConfiguration,
  TaskPushNotificationConfig,
  TaskPushNotificationConfigPage,
  TaskState,
} from './schema.ts'

/** How long one call waits for the peer before giving up. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** One outbound message. */
export interface A2AClientMessage {
  /** Conversation to continue; absent starts one. */
  contextId?: string
  /** Task to continue; absent starts one. */
  taskId?: string
  /** Message text. */
  text: string
  /** Peer-defined message metadata, such as the skill to select. */
  metadata?: Record<string, unknown>
}

/** Client configuration. */
export interface A2AClientOptions {
  /** RPC endpoint, such as `http://127.0.0.1:9310/`. */
  url: string
  /** API key sent as `X-Api-Key`, when the peer requires one. */
  apiKey?: string
  /** How long one call waits for the peer. */
  timeoutMs?: number
}

/** A running task's page, as `ListTasks` reports it. */
export interface A2ATaskPage {
  /** Rows of this page, newest first. */
  tasks: A2ATaskRow[]
  /** Token that reads the next page; empty at the end. */
  nextPageToken: string
  /** How many tasks the filter selects in total. */
  totalSize: number
}

/** One peer's JSON-RPC endpoint. */
export class A2AClient {
  private readonly url: string
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number

  /**
   * @param options - endpoint, authentication, and call timeout.
   */
  constructor(options: A2AClientOptions) {
    this.url = options.url
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Headers every call carries. */
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'A2A-Version': A2A_PROTOCOL_VERSION,
      ...this.apiKey === undefined ? {} : { 'X-Api-Key': this.apiKey },
    }
  }

  /**
   * Read the peer's agent card from the well-known location.
   * @param options - card path and cancellation.
   * @returns the peer's card.
   * @throws Error when the peer does not answer with a card.
   */
  async getCard(options: { path?: string; signal?: AbortSignal } = {}): Promise<AgentCard> {
    const origin = new URL(this.url).origin
    const path = options.path ?? '/.well-known/agent-card.json'
    const response = await fetch(`${origin}${path}`, {
      headers: { 'A2A-Version': A2A_PROTOCOL_VERSION },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (!response.ok) throw new Error(`agent card request failed with HTTP ${response.status}`)
    return await response.json() as AgentCard
  }

  /** Send one JSON-RPC request and read its result. */
  private async rpc(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      ...signal === undefined ? {} : { signal },
    })
    const body = await response.json() as {
      result?: unknown
      error?: { code: number; message: string }
    }
    if (body.error !== undefined) {
      throw new Error(`A2A ${method} failed with code ${body.error.code}: ${body.error.message}`)
    }
    return body.result
  }

  /** Build the protocol's message parameter. */
  private messageParam(message: A2AClientMessage) {
    return {
      messageId: randomUUID(),
      ...message.contextId === undefined ? {} : { contextId: message.contextId },
      ...message.taskId === undefined ? {} : { taskId: message.taskId },
      role: 'ROLE_USER',
      parts: [{ text: message.text }],
      ...message.metadata === undefined ? {} : { metadata: message.metadata },
    }
  }

  /**
   * Send one message and wait for the task to finish.
   * @param message - the message to send.
   * @param signal - cancellation owned by the caller.
   * @param configuration - per-message options, such as an inline webhook registration.
   * @returns the terminal task.
   * @throws Error when the peer refuses the call or answers in message mode.
   */
  async sendMessage(
    message: A2AClientMessage,
    signal?: AbortSignal,
    configuration?: SendConfiguration,
  ): Promise<A2ATask> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const result = await this.rpc('SendMessage', this.sendParams(message, configuration), combine(signal, timeout))
    const task = (result as { task?: A2ATask }).task
    if (task === undefined) {
      throw new Error('A2A SendMessage answered without a task; message-mode answers are not supported')
    }
    return task
  }

  /**
   * Send one message and stream its events until the terminal status.
   *
   * A connection that drops before the first frame is retried once: nothing has
   * been observed yet, so the retry cannot duplicate work. Later drops surface,
   * because the caller has already seen part of the answer.
   * @param message - the message to send.
   * @param signal - cancellation owned by the caller.
   * @param configuration - per-message options, such as an inline webhook registration.
   * @returns the peer's events, in the order it emitted them.
   */
  async *sendMessageStream(
    message: A2AClientMessage,
    signal?: AbortSignal,
    configuration?: SendConfiguration,
  ): AsyncGenerator<A2AStreamEvent> {
    let observed = false
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const event of this.streamAttempt(message, signal, configuration)) {
          observed = true
          yield event
        }
        return
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        if (observed || attempt >= 1 || !isTransient(text)) throw error
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
  }

  /** One attempt at a streaming call: its frames, and nothing else. */
  private async *streamAttempt(
    message: A2AClientMessage,
    signal?: AbortSignal,
    configuration?: SendConfiguration,
  ): AsyncGenerator<A2AStreamEvent> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { ...this.headers(), Accept: 'text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'SendStreamingMessage',
        params: this.sendParams(message, configuration),
      }),
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok || response.body === null) {
      throw new Error(`A2A SendStreamingMessage failed with HTTP ${response.status}: ${await response.text()}`)
    }
    // A refusal the server could answer before opening the stream arrives as a
    // JSON-RPC body under HTTP 200; reading it as SSE would yield nothing.
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      const body = await response.json() as { error?: { code: number; message: string } }
      throw new Error(body.error === undefined
        ? `A2A SendStreamingMessage answered JSON instead of a stream: ${JSON.stringify(body)}`
        : `A2A SendStreamingMessage failed with code ${body.error.code}: ${body.error.message}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let end = buffer.indexOf('\n\n')
      while (end >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = dataOf(frame)
        if (data !== undefined) {
          const event = JSON.parse(data) as A2AStreamEvent & { error?: { code: number; message: string } }
          if (event.error !== undefined) {
            throw new Error(`A2A SendStreamingMessage failed with code ${event.error.code}: ${event.error.message}`)
          }
          yield event
        }
        end = buffer.indexOf('\n\n')
      }
    }
  }

  /**
   * Build the protocol's send parameters. `configuration` appears only when the
   * caller sets an option, because peers reject empty option objects.
   */
  private sendParams(message: A2AClientMessage, configuration?: SendConfiguration): Record<string, unknown> {
    return {
      message: this.messageParam(message),
      ...configuration === undefined ? {} : { configuration },
    }
  }

  /**
   * Register a webhook for one task's events.
   * @param config - webhook, credentials, and the task it reports on.
   * @param signal - cancellation owned by the caller.
   * @returns the stored configuration, including the identity the peer assigned.
   * @throws Error when the peer serves no push notifications.
   */
  async createTaskPushNotificationConfig(
    config: TaskPushNotificationConfig,
    signal?: AbortSignal,
  ): Promise<TaskPushNotificationConfig> {
    return await this.rpc('CreateTaskPushNotificationConfig', config, signal) as TaskPushNotificationConfig
  }

  /**
   * Read one registered webhook.
   * @param params - task and configuration identities.
   * @param signal - cancellation owned by the caller.
   * @returns the stored configuration.
   */
  async getTaskPushNotificationConfig(
    params: { taskId: string; id: string },
    signal?: AbortSignal,
  ): Promise<TaskPushNotificationConfig> {
    return await this.rpc('GetTaskPushNotificationConfig', params, signal) as TaskPushNotificationConfig
  }

  /**
   * Read a task's registered webhooks.
   * @param params - task identity and paging selection.
   * @param signal - cancellation owned by the caller.
   * @returns one page of configurations.
   */
  async listTaskPushNotificationConfigs(
    params: { taskId: string; pageSize?: number; pageToken?: string },
    signal?: AbortSignal,
  ): Promise<TaskPushNotificationConfigPage> {
    return await this.rpc('ListTaskPushNotificationConfigs', params, signal) as TaskPushNotificationConfigPage
  }

  /**
   * Stop a task's events from reaching one webhook.
   * @param params - task and configuration identities.
   * @param signal - cancellation owned by the caller.
   */
  async deleteTaskPushNotificationConfig(
    params: { taskId: string; id: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.rpc('DeleteTaskPushNotificationConfig', params, signal)
  }

  /**
   * Read one task.
   * @param id - task identity.
   * @param signal - cancellation owned by the caller.
   * @returns the task as the peer stores it.
   */
  async getTask(id: string, signal?: AbortSignal): Promise<A2ATask> {
    return await this.rpc('GetTask', { id }, signal) as A2ATask
  }

  /**
   * Read tasks, filtered and paged.
   * @param filter - conversation, state, and paging selection.
   * @param signal - cancellation owned by the caller.
   * @returns one page of tasks.
   */
  async listTasks(
    filter: { contextId?: string; status?: TaskState; pageSize?: number; pageToken?: string } = {},
    signal?: AbortSignal,
  ): Promise<A2ATaskPage> {
    return await this.rpc('ListTasks', filter, signal) as A2ATaskPage
  }

  /**
   * Ask the peer to stop a task.
   * @param id - task identity.
   * @param signal - cancellation owned by the caller.
   * @returns the task after cancellation.
   */
  async cancelTask(id: string, signal?: AbortSignal): Promise<A2ATask> {
    return await this.rpc('CancelTask', { id }, signal) as A2ATask
  }

  /**
   * Stream a running task's events.
   * @param id - task identity.
   * @param signal - cancellation owned by the caller.
   * @returns the task's events until its terminal status.
   */
  async *subscribeToTask(id: string, signal?: AbortSignal): AsyncGenerator<A2AStreamEvent> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { ...this.headers(), Accept: 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'SubscribeToTask', params: { id } }),
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok || response.body === null) {
      throw new Error(`A2A SubscribeToTask failed with HTTP ${response.status}: ${await response.text()}`)
    }
    // A refusal the server could answer before opening the stream (such as a
    // task already terminal) arrives as a JSON-RPC body, not an SSE stream.
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      const body = await response.json() as { error?: { code: number; message: string } }
      throw new Error(body.error === undefined
        ? `A2A SubscribeToTask answered JSON instead of a stream: ${JSON.stringify(body)}`
        : `A2A SubscribeToTask failed with code ${body.error.code}: ${body.error.message}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let end = buffer.indexOf('\n\n')
      while (end >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = dataOf(frame)
        if (data !== undefined) yield JSON.parse(data) as A2AStreamEvent
        end = buffer.indexOf('\n\n')
      }
    }
  }
}

/** Whether a connection failure happened before the peer could do any work. */
function isTransient(message: string): boolean {
  return ['terminated', 'fetch failed', 'ECONNREFUSED', 'ECONNRESET', 'socket hang up']
    .some(fragment => message.includes(fragment))
}

/**
 * Read one SSE frame's payload.
 *
 * The separator's trailing space is optional in the event-stream format, and
 * peers differ on whether they send it, so both spellings are accepted here.
 * @param frame - one complete frame, without its blank-line terminator.
 * @returns the payload of the frame's first non-empty data line, or `undefined` when it has none.
 */
function dataOf(frame: string): string | undefined {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    const value = line.slice('data:'.length)
    const data = value.startsWith(' ') ? value.slice(1) : value
    if (data.length > 0) return data
  }
  return undefined
}

/** Combine a caller's cancellation with the call's own timeout. */
function combine(signal: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}
