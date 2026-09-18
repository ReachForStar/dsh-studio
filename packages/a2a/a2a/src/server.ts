import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { A2AStreamEvent, A2AMessage, AgentCard, A2APart, A2ATask, Role, TaskState } from './schema.ts'
import { A2A_PROTOCOL_VERSION, isTerminal, textOf } from './schema.ts'
import { TaskStore, type TaskCursor } from './task-store.ts'

/** How one execution reports progress back to the protocol. */
export interface A2AStreamSink {
  /**
   * Move the task to a new state.
   * @param state - the state to publish.
   * @param text - status message text, when the state carries one.
   */
  sendStatus(state: TaskState, text?: string): void
  /**
   * Append text to an artifact, creating it on first write.
   * @param artifactId - artifact identity, stable across updates.
   * @param name - artifact name, used when the artifact is created.
   * @param text - text to append.
   * @param lastChunk - whether this update completes the artifact.
   */
  appendArtifact(artifactId: string, name: string, text: string, lastChunk?: boolean): void
}

/** One message an agent was asked to work on. */
export interface A2AExecutorContext {
  /** Task identity the execution reports against. */
  readonly taskId: string
  /** Conversation the task belongs to; the unit a caller continues. */
  readonly contextId: string
  /** Skill the caller selected through `metadata.skill`, or `default`. */
  readonly skill: string
  /** Text of the caller's message. */
  readonly text: string
  /** Peer-defined task metadata. */
  readonly metadata: Record<string, unknown>
  /** Progress and artifact reporting. */
  readonly sink: A2AStreamSink
}

/** What an agent implements to serve A2A tasks. */
export interface A2AExecutor {
  /**
   * Execute one user message. Resolving completes the task unless the executor
   * already published a terminal state; throwing fails it.
   * @param context - the task to execute and the sink to report through.
   */
  onMessage(context: A2AExecutorContext): Promise<void>
  /**
   * Stop the work behind a task the caller canceled.
   * @param context - identities of the canceled task.
   */
  onCancel?(context: { taskId: string; contextId: string }): void
}

/** Server configuration. */
export interface A2ARequestHandlerOptions {
  /** Card served at `/.well-known/agent-card.json` and by `GetExtendedAgentCard`. */
  card: AgentCard
  /** What executes the tasks. */
  executor: A2AExecutor
  /** Value required in `X-Api-Key` on RPC calls; empty serves without authentication. */
  apiKey?: string
  /** Task table to work against; a fresh one when absent. */
  store?: TaskStore
  /** Request body cap in bytes. */
  maxBodyBytes?: number
  /** Where request failures are reported. */
  onError?: (message: string, error: unknown) => void
}

/** A server bound to a port. */
export interface A2AServer {
  /** The bound HTTP server. */
  readonly server: http.Server
  /** The task table this server serves from. */
  readonly store: TaskStore
  /** Resolves once the listener is up, rejects when it cannot bind. */
  readonly ready: Promise<void>
  /**
   * Stop the listener.
   * @returns a promise resolved once the listener closed.
   */
  close(): Promise<void>
}

/** JSON-RPC codes this server raises. */
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
const SERVER_ERROR = -32000
const TASK_NOT_FOUND = -32001
const TASK_NOT_CANCELABLE = -32002
const PUSH_NOTIFICATION_NOT_SUPPORTED = -32003
const UNSUPPORTED_OPERATION = -32004
const VERSION_NOT_SUPPORTED = -32009

/** How long `SubscribeToTask` waits for a running task before giving up. */
const SUBSCRIBE_TIMEOUT_MS = 10 * 60 * 1000

/** Default request body cap: one A2A message, well under any file transfer. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/** A JSON-RPC failure carrying the protocol's code and `ErrorInfo` payload. */
class RpcError extends Error {
  /**
   * @param code - JSON-RPC error code.
   * @param message - human-readable failure.
   * @param data - JSON-RPC error data, if any.
   */
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'RpcError'
  }
}

/** The protocol's error payload: `google.rpc.ErrorInfo` with an uppercase snake reason. */
function a2aError(code: number, reason: string, message: string, metadata?: Record<string, unknown>): RpcError {
  return new RpcError(code, message, [{
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason,
    domain: 'a2a-protocol.org',
    ...metadata === undefined ? {} : { metadata },
  }])
}

/** A request's parsed message parameter. */
interface IncomingMessage {
  contextId?: string
  taskId?: string
  role: Role
  parts: A2APart[]
  metadata?: Record<string, unknown>
}

/** A request's parsed execution configuration. */
interface IncomingConfiguration {
  returnImmediately?: boolean
  historyLength?: number
}

/** Whether a parsed JSON value is an object with string keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the `params.message` of a request. */
function parseMessage(value: unknown): IncomingMessage {
  if (!isRecord(value)) throw a2aError(INVALID_PARAMS, 'INVALID_ARGUMENT', 'params.message required')
  const parts = value.parts
  if (!Array.isArray(parts)) throw a2aError(INVALID_PARAMS, 'INVALID_ARGUMENT', 'params.message.parts required')
  return {
    ...typeof value.contextId === 'string' ? { contextId: value.contextId } : {},
    ...typeof value.taskId === 'string' ? { taskId: value.taskId } : {},
    role: value.role === 'ROLE_AGENT' ? 'ROLE_AGENT' : 'ROLE_USER',
    parts: parts as A2APart[],
    ...isRecord(value.metadata) ? { metadata: value.metadata } : {},
  }
}

/** Parse the `params.configuration` of a request. */
function parseConfiguration(value: unknown): IncomingConfiguration {
  if (!isRecord(value)) return {}
  return {
    ...value.returnImmediately === true ? { returnImmediately: true } : {},
    ...typeof value.historyLength === 'number' ? { historyLength: value.historyLength } : {},
  }
}

/** Write one JSON-RPC result. */
function sendResult(res: http.ServerResponse, id: unknown, result: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

/** Write one JSON-RPC error. */
function sendError(res: http.ServerResponse, id: unknown, error: RpcError): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: error.code,
      message: error.message,
      ...error.data === undefined ? {} : { data: error.data },
    },
  }))
}

/** Write a fresh error value for a code that has no protocol `ErrorInfo`. */
function plainError(code: number, message: string): RpcError {
  return new RpcError(code, message)
}

/**
 * Build the HTTP handler serving one A2A agent.
 *
 * The handler owns the whole response lifecycle, so it mounts on any HTTP
 * server: the harness webserver at a prefix, or a dedicated listener.
 * @param options - card, executor, authentication, and store.
 * @returns the request handler.
 */
export function createA2ARequestHandler(
  options: A2ARequestHandlerOptions,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const store = options.store ?? new TaskStore()
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const onError = options.onError ?? (() => {})
  /** Frames of running tasks, so `SubscribeToTask` can join mid-execution. */
  const subscribers = new Map<string, Set<(event: A2AStreamEvent) => void>>()

  /** Whether the request carries the configured API key. */
  const authenticated = (req: http.IncomingMessage): boolean =>
    options.apiKey === undefined || options.apiKey.length === 0 || req.headers['x-api-key'] === options.apiKey

  /** The skill a message selects, defaulting to `default`. */
  const skillOf = (message: IncomingMessage): string => {
    const fromMessage = message.metadata?.skill
    if (typeof fromMessage === 'string' && fromMessage.length > 0) return fromMessage
    const fromPart = message.parts[0]?.metadata?.skill
    if (typeof fromPart === 'string' && fromPart.length > 0) return fromPart
    return 'default'
  }

  /** Subscriber set of one task, created on demand. */
  const subscriberSet = (taskId: string): Set<(event: A2AStreamEvent) => void> => {
    const existing = subscribers.get(taskId)
    if (existing !== undefined) return existing
    const created = new Set<(event: A2AStreamEvent) => void>()
    subscribers.set(taskId, created)
    return created
  }

  /**
   * Execute one message: resolve or create its task, drive the executor, and
   * leave the task in a terminal state. A non-blocking call returns the running
   * task and finishes in the background.
   */
  async function runMessage(
    message: IncomingMessage,
    configuration: IncomingConfiguration,
    live?: (event: A2AStreamEvent) => void,
  ): Promise<A2ATask> {
    const existing = message.taskId === undefined ? undefined : store.get(message.taskId)
    if (message.taskId !== undefined && existing === undefined) {
      throw a2aError(TASK_NOT_FOUND, 'TASK_NOT_FOUND', `Task not found: ${message.taskId}`, { taskId: message.taskId })
    }
    // Terminal states (completed/failed/canceled/rejected) take no further messages;
    // input-required and auth-required are interruptions the caller may continue.
    if (existing !== undefined && isTerminal(existing.status.state)) {
      throw a2aError(UNSUPPORTED_OPERATION, 'UNSUPPORTED_OPERATION', `Task ${existing.id} is ${existing.status.state} and cannot accept further messages`)
    }
    if (existing !== undefined && message.contextId !== undefined && message.contextId !== existing.contextId) {
      throw a2aError(INVALID_PARAMS, 'INVALID_ARGUMENT', `contextId ${message.contextId} does not match task ${existing.id}`)
    }
    const task = existing ?? store.create(message.contextId, message.metadata)
    store.pushHistory(task, {
      messageId: randomUUID(),
      contextId: task.contextId,
      taskId: task.id,
      role: 'ROLE_USER',
      parts: message.parts,
      ...message.metadata === undefined ? {} : { metadata: message.metadata },
    })

    const own = subscriberSet(task.id)
    const emit = (event: A2AStreamEvent): void => {
      live?.(event)
      for (const send of own) {
        try {
          send(event)
        } catch {
          // A subscriber whose response already closed cannot be reported to.
        }
      }
    }

    store.setStatus(task, 'TASK_STATE_SUBMITTED')
    emit({ task: structuredClone(task) })

    let settled = false
    const sink: A2AStreamSink = {
      sendStatus(state, text) {
        store.setStatus(task, state, text)
        settled = isTerminal(state)
        emit({ statusUpdate: { taskId: task.id, contextId: task.contextId, status: structuredClone(task.status) } })
      },
      appendArtifact(artifactId, name, text, lastChunk) {
        store.appendArtifact(task, artifactId, name, text)
        emit({
          artifactUpdate: {
            taskId: task.id,
            contextId: task.contextId,
            artifact: { artifactId, name, parts: [{ text }] },
            append: true,
            ...lastChunk === undefined ? {} : { lastChunk },
          },
        })
      },
    }

    /** Publish the terminal status of a successful run. */
    const finish = (): A2ATask => {
      if (!settled && !isTerminal(task.status.state)) store.setStatus(task, 'TASK_STATE_COMPLETED')
      emit({ statusUpdate: { taskId: task.id, contextId: task.contextId, status: structuredClone(task.status) } })
      subscribers.delete(task.id)
      return structuredClone(task)
    }
    /** Publish the terminal status of a failed run. */
    const fail = (error: unknown): A2ATask => {
      if (!isTerminal(task.status.state)) {
        store.setStatus(task, 'TASK_STATE_FAILED', error instanceof Error ? error.message : String(error))
      }
      emit({ statusUpdate: { taskId: task.id, contextId: task.contextId, status: structuredClone(task.status) } })
      subscribers.delete(task.id)
      return structuredClone(task)
    }

    const execution = options.executor.onMessage({
      taskId: task.id,
      contextId: task.contextId,
      skill: skillOf(message),
      text: textOf(message.parts),
      metadata: message.metadata ?? {},
      sink,
    })
    if (configuration.returnImmediately === true) {
      // The caller asked not to wait: the turn keeps running in the background,
      // and the terminal status reaches it through GetTask or SubscribeToTask.
      void execution.then(finish, fail)
      return structuredClone(task)
    }
    try {
      await execution
      return finish()
    } catch (error) {
      return fail(error)
    }
  }

  /** Serve one parsed JSON-RPC request. */
  async function handleRequest(res: http.ServerResponse, requestedVersion: string, body: string): Promise<void> {
    if (requestedVersion !== A2A_PROTOCOL_VERSION) {
      sendError(res, null, a2aError(VERSION_NOT_SUPPORTED, 'FAILED_PRECONDITION', `A2A protocol version ${requestedVersion} is not supported; this server speaks ${A2A_PROTOCOL_VERSION}`))
      return
    }
    let rpc: unknown
    try {
      rpc = JSON.parse(body)
    } catch {
      sendError(res, null, plainError(PARSE_ERROR, 'Parse error'))
      return
    }
    if (!isRecord(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      sendError(res, isRecord(rpc) ? rpc.id ?? null : null, plainError(INVALID_REQUEST, 'Invalid request'))
      return
    }
    const params = isRecord(rpc.params) ? rpc.params : {}
    try {
      switch (rpc.method) {
        case 'SendMessage': {
          const task = await runMessage(parseMessage(params.message), parseConfiguration(params.configuration))
          sendResult(res, rpc.id, { task })
          return
        }
        case 'SendStreamingMessage': {
          const message = parseMessage(params.message)
          await streamMessage(res, rpc.id, message, parseConfiguration(params.configuration))
          return
        }
        case 'GetTask': {
          const task = requireTask(store, params.id)
          const historyLength = typeof params.historyLength === 'number' ? params.historyLength : undefined
          const result = structuredClone(task)
          if (historyLength !== undefined) {
            // Zero means no history at all; the field is omitted rather than emptied.
            if (historyLength <= 0) delete (result as { history?: A2AMessage[] }).history
            else result.history = task.history.slice(-historyLength)
          }
          sendResult(res, rpc.id, result)
          return
        }
        case 'ListTasks': {
          const filter = {
            ...typeof params.contextId === 'string' ? { contextId: params.contextId } : {},
            ...typeof params.status === 'string' ? { status: params.status as TaskState } : {},
          }
          const pageSize = typeof params.pageSize === 'number' ? Math.min(Math.max(params.pageSize, 1), 100) : 50
          let cursor: TaskCursor | undefined
          if (typeof params.pageToken === 'string' && params.pageToken.length > 0) {
            cursor = decodePageToken(params.pageToken)
            if (cursor === undefined) throw a2aError(INVALID_PARAMS, 'INVALID_ARGUMENT', 'params.pageToken is not a valid cursor')
          }
          const totalSize = store.count(filter)
          // One extra row past the page detects whether a next page exists.
          const rows = store.list(filter, pageSize + 1, params.includeArtifacts === true, cursor)
          const hasMore = rows.length > pageSize
          const page = hasMore ? rows.slice(0, pageSize) : rows
          const last = page[page.length - 1]
          sendResult(res, rpc.id, {
            tasks: page,
            nextPageToken: hasMore && last !== undefined ? encodePageToken(last) : '',
            pageSize: page.length,
            totalSize,
          })
          return
        }
        case 'CancelTask': {
          const task = requireTask(store, params.id)
          if (isTerminal(task.status.state)) {
            throw a2aError(TASK_NOT_CANCELABLE, 'TASK_NOT_CANCELABLE', `Task ${task.id} is ${task.status.state} and cannot be canceled`)
          }
          options.executor.onCancel?.({ taskId: task.id, contextId: task.contextId })
          store.setStatus(task, 'TASK_STATE_CANCELED')
          subscribers.delete(task.id)
          sendResult(res, rpc.id, structuredClone(task))
          return
        }
        case 'SubscribeToTask':
          await subscribe(res, params.id)
          return
        case 'GetExtendedAgentCard':
          // The card does not declare the capability, so the operation is a refusal.
          if (options.card.capabilities.extendedAgentCard !== true) {
            throw a2aError(UNSUPPORTED_OPERATION, 'UNSUPPORTED_OPERATION', 'an extended agent card is not configured')
          }
          sendResult(res, rpc.id, structuredClone(options.card))
          return
        case 'CreateTaskPushNotificationConfig':
        case 'GetTaskPushNotificationConfig':
        case 'ListTaskPushNotificationConfigs':
        case 'DeleteTaskPushNotificationConfig':
          throw a2aError(PUSH_NOTIFICATION_NOT_SUPPORTED, 'PUSH_NOTIFICATION_NOT_SUPPORTED', 'push notification configuration is not served')
        default:
          throw plainError(METHOD_NOT_FOUND, `Method not found: ${rpc.method}`)
      }
    } catch (error) {
      if (error instanceof RpcError) {
        sendError(res, rpc.id, error)
        return
      }
      sendError(res, rpc.id, plainError(INTERNAL_ERROR, error instanceof Error ? error.message : String(error)))
    }
  }

  /** Stream one message's events until its terminal status. */
  async function streamMessage(
    res: http.ServerResponse,
    id: unknown,
    message: IncomingMessage,
    configuration: IncomingConfiguration,
  ): Promise<void> {
    const frames = openEventStream(res)
    try {
      // Errors after the response headers can only travel as SSE frames: writing
      // a second head would throw out of the request handler.
      await runMessage(message, configuration, (frame) => { frames.send(frame) })
    } catch (error) {
      frames.send({
        jsonrpc: '2.0',
        id,
        error: {
          code: error instanceof RpcError ? error.code : INTERNAL_ERROR,
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
    frames.close()
  }

  /** Stream a running task's events until it ends. */
  async function subscribe(res: http.ServerResponse, taskId: unknown): Promise<void> {
    if (typeof taskId !== 'string') throw a2aError(INVALID_PARAMS, 'INVALID_ARGUMENT', 'params.id required')
    const task = requireTask(store, taskId)
    // The refusal must leave before the response headers, so it travels as a
    // JSON-RPC error instead of an SSE frame.
    if (isTerminal(task.status.state)) {
      throw a2aError(UNSUPPORTED_OPERATION, 'UNSUPPORTED_OPERATION', `Task ${task.id} is ${task.status.state} and cannot be subscribed to`)
    }
    const frames = openEventStream(res)
    frames.send({ task: structuredClone(task) })
    if (isTerminal(task.status.state)) {
      frames.close()
      return
    }
    await new Promise<void>((resolve) => {
      const own = subscriberSet(task.id)
      const listen = (event: A2AStreamEvent): void => {
        frames.send(event)
        if ('statusUpdate' in event && isTerminal(event.statusUpdate.status.state)) {
          own.delete(listen)
          resolve()
        }
      }
      own.add(listen)
      // The task may have ended between the read above and this subscription.
      const current = store.get(task.id)
      if (current === undefined || isTerminal(current.status.state)) {
        own.delete(listen)
        if (current !== undefined) {
          frames.send({ statusUpdate: { taskId: current.id, contextId: current.contextId, status: current.status } })
        }
        resolve()
        return
      }
      setTimeout(() => {
        own.delete(listen)
        resolve()
      }, SUBSCRIBE_TIMEOUT_MS).unref()
    })
    frames.close()
  }

  return (req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, agent: options.card.name }))
      return
    }
    if (req.method === 'GET' && (url === '/.well-known/agent-card.json' || url === '/.well-known/agent.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(options.card, null, 2))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    if (!authenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: SERVER_ERROR, message: 'unauthorized' } }))
      return
    }
    const requestedVersion = requestedProtocolVersion(req)
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      if (rejected) return
      size += chunk.length
      if (size > maxBodyBytes) {
        rejected = true
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'request body too large' } }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (rejected) return
      void handleRequest(res, requestedVersion, Buffer.concat(chunks).toString('utf8')).catch((error: unknown) => {
        onError('handling an A2A request failed', error)
        if (!res.headersSent) {
          sendError(res, null, plainError(INTERNAL_ERROR, error instanceof Error ? error.message : String(error)))
        }
      })
    })
  }
}

/** Read a task by an RPC parameter, or raise the protocol's not-found error. */
function requireTask(store: TaskStore, id: unknown): A2ATask {
  if (typeof id !== 'string') throw a2aError(INVALID_PARAMS, 'INVALID_ARGUMENT', 'params.id required')
  const task = store.get(id)
  if (task === undefined) {
    throw a2aError(TASK_NOT_FOUND, 'TASK_NOT_FOUND', `Task not found: ${id}`, { taskId: id })
  }
  return task
}

/**
 * The protocol version a request asks for. An absent or empty value is 0.3,
 * the version the protocol assumes for legacy clients; the request parameter
 * form the protocol allows takes over when the header is absent.
 */
function requestedProtocolVersion(req: http.IncomingMessage): string {
  const header = req.headers['a2a-version']
  const fromHeader = Array.isArray(header) ? header[0] : header
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return majorMinor(fromHeader)
  try {
    const fromQuery = new URL(req.url ?? '/', 'http://localhost').searchParams.get('A2A-Version')
    if (fromQuery !== null && fromQuery.length > 0) return majorMinor(fromQuery)
  } catch {
    // A request URL that does not parse cannot carry the parameter; 0.3 stays assumed.
  }
  return '0.3'
}

/** Reduce a version string to the `Major.Minor` elements the protocol negotiates. */
function majorMinor(version: string): string {
  const parts = version.trim().split('.')
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : version.trim()
}

/** Encode one row as the `ListTasks` page token for the next page. */
function encodePageToken(row: { id: string; status: { timestamp: string } }): string {
  return Buffer.from(JSON.stringify({ t: row.status.timestamp, i: row.id }), 'utf8').toString('base64url')
}

/** Decode a `ListTasks` page token, or undefined when it is not one this server issued. */
function decodePageToken(token: string): TaskCursor | undefined {
  try {
    const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown }
    if (typeof value.t !== 'string' || typeof value.i !== 'string') return undefined
    return { timestamp: value.t, id: value.i }
  } catch {
    return undefined
  }
}

/**
 * One frame an event stream carries: a stream event, or the JSON-RPC error a
 * request that failed after the response headers went out.
 */
type StreamFrame = A2AStreamEvent | {
  jsonrpc: '2.0'
  id: unknown
  error: { code: number; message: string }
}

/** An open SSE response: frames are written until the caller closes it. */
interface EventStream {
  /** Write one frame. */
  send(frame: StreamFrame): void
  /** End the response, unless the client already went away. */
  close(): void
}

/** Open one SSE response with the framing the protocol requires. */
function openEventStream(res: http.ServerResponse): EventStream {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  let closed = false
  res.on('close', () => {
    closed = true
  })
  return {
    send(event) {
      if (closed) return
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      } catch {
        // A write to a socket the peer already closed reports here; the stream
        // is finished either way.
        closed = true
      }
    },
    close() {
      if (!closed) res.end()
    },
  }
}

/** Server configuration: the handler's options plus where to listen. */
export interface A2AServerOptions extends A2ARequestHandlerOptions {
  /** TCP port to bind; 0 binds a free port. */
  port: number
  /** Interface to bind; loopback by default. */
  host?: string
}

/**
 * Build an A2A server on its own listener.
 * @param options - card, executor, authentication, task table, and address.
 * @returns the server, its task table, and its readiness.
 */
export function createA2AServer(options: A2AServerOptions): A2AServer {
  const store = options.store ?? new TaskStore()
  const server = http.createServer(createA2ARequestHandler({ ...options, store }))
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      resolve()
    })
    server.once('error', reject)
  })
  // A failed bind must not crash the process before the owner awaits `ready`.
  ready.catch(() => {})
  server.listen(options.port, options.host ?? '127.0.0.1')
  return {
    server,
    store,
    ready,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}
