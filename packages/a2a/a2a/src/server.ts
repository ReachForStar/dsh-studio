import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type {
  A2AStreamEvent,
  A2AMessage,
  AgentCard,
  A2APart,
  A2ATask,
  Role,
  TaskPushNotificationConfig,
  TaskState,
} from './schema.ts'
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

/** 多路 sink：同一份状态写多个 sink，总线入口与 RPC 入口共用同一套语义。 */
export function teeSink(...sinks: A2AStreamSink[]): A2AStreamSink {
  return {
    sendStatus(state, text) {
      for (const sink of sinks) sink.sendStatus(state, text)
    },
    appendArtifact(artifactId, name, text, lastChunk) {
      for (const sink of sinks) sink.appendArtifact(artifactId, name, text, lastChunk)
    },
  }
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
  /** 任务取消信号；超时或 CancelTask 触发，执行器应停止并抛错。 */
  readonly signal?: AbortSignal
}

/** 一个任务的执行期视图：执行器只能拿 sink，终态由 finish/fail 统一落。 */
export interface TaskSession {
  /** 不经状态机广播一帧（如初始 task 快照）。 */
  emit(event: A2AStreamEvent): void
  /** 进度与工件报告。 */
  readonly sink: A2AStreamSink
  /** 置 COMPLETED 并广播终态，返回终态任务快照。 */
  finish(): A2ATask
  /** 置 FAILED 并广播终态，返回终态任务快照。 */
  fail(error: unknown): A2ATask
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
  /** 单任务执行超时（毫秒）；超时取消并置 FAILED，默认 10 分钟。 */
  taskTimeoutMs?: number
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
   * 非 RPC 入口（总线消费）用：按调用方给定 taskId 落库，返回与 RPC 路径同一套 sink，
   * 使总线任务在 GetTask/ListTasks/push 投递上行为一致。
   */
  attachTask(input: { taskId: string; contextId: string; metadata?: Record<string, unknown> }): TaskSession
  /**
   * 执行一轮；suppliedSession 供总线入口传入 attachTask 建好的会话，
   * 终态统一由该会话落，调用方勿重复 finish/fail。
   */
  executeTask(
    context: Omit<A2AExecutorContext, 'sink'> & { sink?: A2AStreamSink },
    session?: TaskSession,
  ): Promise<A2ATask>
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

/** webhook 单次投递超时（防慢接收方拖住服务端）。 */
const PUSH_TIMEOUT_MS = 10_000

/** 默认单任务执行超时：10 分钟。 */
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000

/** Push 配置存储：按 taskId 分桶，配置 id 为资源标识（缺省生成 UUID）。 */
class PushConfigStore {
  private readonly byTask = new Map<string, Map<string, TaskPushNotificationConfig>>()

  put(input: TaskPushNotificationConfig): TaskPushNotificationConfig {
    const taskId = input.taskId as string
    const id = input.id ?? randomUUID()
    const config: TaskPushNotificationConfig = { ...input, id, taskId }
    const bucket = this.byTask.get(taskId) ?? new Map<string, TaskPushNotificationConfig>()
    bucket.set(id, config)
    this.byTask.set(taskId, bucket)
    return config
  }

  get(taskId: string, id: string): TaskPushNotificationConfig | undefined {
    return this.byTask.get(taskId)?.get(id)
  }

  list(taskId: string): TaskPushNotificationConfig[] {
    return [...(this.byTask.get(taskId)?.values() ?? [])]
  }

  delete(taskId: string, id: string): boolean {
    const bucket = this.byTask.get(taskId)
    if (bucket === undefined) return false
    const ok = bucket.delete(id)
    if (bucket.size === 0) this.byTask.delete(taskId)
    return ok
  }

  /** 任务淘汰时清理该任务的全部 push 配置。 */
  dropTask(taskId: string): void {
    this.byTask.delete(taskId)
  }
}

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
  /** 发送时内联注册 push 配置；规范要求此时 taskId 留空，由服务端按任务填。 */
  taskPushNotificationConfig?: TaskPushNotificationConfig
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
    ...isRecord(value.taskPushNotificationConfig) ? { taskPushNotificationConfig: parsePushConfig(value.taskPushNotificationConfig) } : {},
  }
}

/** Parse one push notification configuration from its wire form. */
function parsePushConfig(value: Record<string, unknown>): TaskPushNotificationConfig {
  if (typeof value.url !== 'string' || value.url.length === 0) {
    throw a2aError(INVALID_PARAMS, 'INVALID_ARGUMENT', 'configuration.taskPushNotificationConfig.url required')
  }
  const config: TaskPushNotificationConfig = { url: value.url }
  if (typeof value.id === 'string') config.id = value.id
  if (typeof value.taskId === 'string') config.taskId = value.taskId
  if (typeof value.token === 'string') config.token = value.token
  if (typeof value.tenant === 'string') config.tenant = value.tenant
  if (isRecord(value.authentication)) {
    const scheme = value.authentication.scheme
    if (typeof scheme === 'string' && scheme.length > 0) {
      config.authentication = { scheme }
      const credentials = value.authentication.credentials
      if (typeof credentials === 'string') config.authentication.credentials = credentials
    }
  }
  return config
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

/** 内部核心：HTTP handler 与总线入口共用的任务执行状态。 */
interface A2ACore {
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void
  attachTask(input: { taskId: string; contextId: string; metadata?: Record<string, unknown> }): TaskSession
  executeTask(
    context: Omit<A2AExecutorContext, 'sink'> & { sink?: A2AStreamSink },
    session?: TaskSession,
  ): Promise<A2ATask>
}

/**
 * Build the core serving one A2A agent: the HTTP handler plus the bus-entry
 * surfaces that share its task table and push delivery.
 *
 * The core owns the whole response lifecycle, so the handler mounts on any HTTP
 * server: the harness webserver at a prefix, or a dedicated listener.
 * @param options - card, executor, authentication, and store.
 * @returns the handler, bus-entry surfaces, and execution driver.
 */
function createA2ACore(options: A2ARequestHandlerOptions): A2ACore {
  const store = options.store ?? new TaskStore()
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const onError = options.onError ?? (() => {})
  const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
  if (!Number.isFinite(taskTimeoutMs) || taskTimeoutMs <= 0 || taskTimeoutMs > 2_147_483_647) {
    throw new Error('taskTimeoutMs must be a millisecond value between 1 and 2147483647')
  }
  /** Frames of running tasks, so `SubscribeToTask` can join mid-execution. */
  const subscribers = new Map<string, Set<(event: A2AStreamEvent) => void>>()
  /** 运行中任务的执行句柄，CancelTask 与超时通过它取消。 */
  const executions = new Map<string, { promise: Promise<A2ATask>; cancel(error?: Error): void }>()
  /** push 配置与任务同生命周期；能力按卡片声明（未声明则 4 个方法一律拒绝）。 */
  const pushStore = new PushConfigStore()
  /** 每配置一条串行投递链：规范要求事件按生成顺序投递，并发 POST 会乱序。 */
  const pushQueues = new Map<string, Promise<void>>()
  store.onEvict = (taskId) => {
    pushStore.dropTask(taskId)
    for (const key of [...pushQueues.keys()]) if (key.startsWith(`${taskId}/`)) pushQueues.delete(key)
  }
  const pushEnabled = options.card.capabilities.pushNotifications === true

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

  /** 能力门控：未声明 pushNotifications 时 4 个配置方法一律拒绝。 */
  function requirePushSupport(): void {
    if (pushEnabled) return
    throw a2aError(PUSH_NOTIFICATION_NOT_SUPPORTED, 'PUSH_NOTIFICATION_NOT_SUPPORTED', 'push notification configuration is not served')
  }

  /** 投递请求头：Content-Type + Authentication + 旧版 token 头。 */
  function pushHeaders(config: TaskPushNotificationConfig): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/a2a+json' }
    if (config.authentication !== undefined) {
      headers.Authorization = config.authentication.credentials !== undefined
        ? `${config.authentication.scheme} ${config.authentication.credentials}`
        : config.authentication.scheme
    }
    if (config.token !== undefined) headers['X-A2A-Notification-Token'] = config.token
    return headers
  }

  /** 投递一帧：至少一次（网络错误/5xx 再试一次），10s 超时；失败只记日志，不影响任务。 */
  async function deliverPush(config: TaskPushNotificationConfig, payload: string, attempt = 1): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS)
    let retryable = false
    let detail = ''
    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers: pushHeaders(config),
        body: payload,
        signal: controller.signal,
      })
      await response.body?.cancel().catch(() => {})
      if (response.ok) return
      retryable = response.status >= 500
      detail = `HTTP ${String(response.status)}`
    } catch (error) {
      retryable = true
      detail = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
    }
    if (retryable && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 500))
      return deliverPush(config, payload, attempt + 1)
    }
    onError('A2A push delivery failed', new Error(`attempt ${String(attempt)} -> ${config.url} taskId=${config.taskId ?? ''}: ${detail}`))
  }

  /** 每配置一条串行投递链：规范要求事件按生成顺序投递。 */
  function enqueuePush(config: TaskPushNotificationConfig, payload: string): void {
    const key = `${config.taskId ?? ''}/${config.id ?? ''}`
    const next = (pushQueues.get(key) ?? Promise.resolve())
      .then(() => deliverPush(config, payload))
      .catch(() => {})
    pushQueues.set(key, next)
    void next.finally(() => {
      if (pushQueues.get(key) === next) pushQueues.delete(key)
    })
  }

  /** 任务事件出口：SSE 订阅者 + 已注册 webhook（投递异步，不阻塞任务执行）。 */
  function broadcast(taskId: string, frame: A2AStreamEvent): void {
    for (const send of subscribers.get(taskId) ?? []) {
      try {
        send(frame)
      } catch {
        // 订阅者写失败（已断开）忽略
      }
    }
    const configs = pushStore.list(taskId)
    if (configs.length === 0) return
    const payload = JSON.stringify(frame)
    for (const config of configs) enqueuePush(config, payload)
  }

  /** 任务执行期视图：状态/工件写库 + 广播（A2A RPC 与总线入口共用同一套语义）。 */
  function taskSession(task: A2ATask, onEvent?: (event: A2AStreamEvent) => void): TaskSession {
    subscriberSet(task.id)
    const emit = (event: A2AStreamEvent): void => {
      onEvent?.(event)
      broadcast(task.id, event)
    }
    const statusFrame = (): A2AStreamEvent => ({
      statusUpdate: { taskId: task.id, contextId: task.contextId, status: structuredClone(task.status) },
    })
    let finished = false
    return {
      emit,
      sink: {
        sendStatus(state, text) {
          if (finished || isTerminal(task.status.state)) return
          store.setStatus(task, state, text)
          emit(statusFrame())
        },
        appendArtifact(artifactId, name, text, lastChunk) {
          if (finished || isTerminal(task.status.state)) return
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
      },
      finish() {
        if (!finished && !isTerminal(task.status.state)) {
          store.setStatus(task, 'TASK_STATE_COMPLETED')
          emit(statusFrame())
        }
        finished = true
        subscribers.delete(task.id)
        return structuredClone(task)
      },
      fail(error) {
        if (!finished && !isTerminal(task.status.state)) {
          store.setStatus(task, 'TASK_STATE_FAILED', error instanceof Error ? error.message : String(error))
          emit(statusFrame())
        }
        finished = true
        subscribers.delete(task.id)
        return structuredClone(task)
      },
    }
  }

  /** 总线等非 RPC 入口：按调用方给定 taskId 落库并返回同一套 sink。 */
  function attachTask(input: { taskId: string; contextId: string; metadata?: Record<string, unknown> }): TaskSession {
    return taskSession(store.ensureTask(input.taskId, input.contextId, input.metadata))
  }

  /** 执行一轮：驱动 executor，带超时取消与 AbortSignal；终态由 session 统一落。 */
  function executeTask(
    context: Omit<A2AExecutorContext, 'sink'> & { sink?: A2AStreamSink },
    suppliedSession?: TaskSession,
  ): Promise<A2ATask> {
    const task = context.taskId !== undefined
      ? store.ensureTask(context.taskId, context.contextId, context.metadata)
      : store.create(context.contextId, context.metadata)
    if (isTerminal(task.status.state)) return Promise.resolve(structuredClone(task))
    const existing = executions.get(task.id)
    if (existing !== undefined) return existing.promise
    const session = suppliedSession ?? taskSession(task)
    const controller = new AbortController()
    let settled = false
    let rejectStopped!: (error: Error) => void
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject })
    const cancel = (error: Error = new Error('task canceled')): void => {
      if (controller.signal.aborted || settled) return
      rejectStopped(error)
      controller.abort(error)
      void Promise.resolve().then(() => options.executor.onCancel?.({ taskId: task.id, contextId: task.contextId }))
        .catch((cancelError) => onError('A2A onCancel failed', cancelError))
    }
    const sink: A2AStreamSink = {
      sendStatus(state, text) {
        if (settled || controller.signal.aborted || isTerminal(task.status.state)) return
        session.sink.sendStatus(state, text)
        context.sink?.sendStatus(state, text)
      },
      appendArtifact(artifactId, name, text, lastChunk) {
        if (settled || controller.signal.aborted || isTerminal(task.status.state)) return
        session.sink.appendArtifact(artifactId, name, text, lastChunk)
        context.sink?.appendArtifact(artifactId, name, text, lastChunk)
      },
    }
    const timer = setTimeout(() => cancel(new Error(`task timed out after ${String(taskTimeoutMs)}ms`)), taskTimeoutMs)
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return options.executor.onMessage({ ...context, sink, signal: controller.signal })
    })
    const promise = Promise.race([work, stopped])
      .then(() => session.finish(), (error) => session.fail(error))
      .finally(() => {
        settled = true
        clearTimeout(timer)
        executions.delete(task.id)
      })
    executions.set(task.id, { promise, cancel })
    return promise
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

    // 内联 push 配置：必须在首个事件发出前注册，否则 SUBMITTED 帧投不出去
    const inlinePush = configuration.taskPushNotificationConfig
    if (inlinePush !== undefined) {
      requirePushSupport()
      pushStore.put({ ...inlinePush, taskId: task.id })
    }

    store.pushHistory(task, {
      messageId: randomUUID(),
      contextId: task.contextId,
      taskId: task.id,
      role: 'ROLE_USER',
      parts: message.parts,
      ...message.metadata === undefined ? {} : { metadata: message.metadata },
    })

    const session = taskSession(task, live)
    store.setStatus(task, 'TASK_STATE_SUBMITTED')
    session.emit({ task: structuredClone(task) })

    const exec = {
      taskId: task.id,
      contextId: task.contextId,
      skill: skillOf(message),
      text: textOf(message.parts),
      metadata: message.metadata ?? {},
    }
    if (configuration.returnImmediately === true) {
      // 调用方要求不等：后台继续执行，终态通过 GetTask/SubscribeToTask/push 到达
      const snapshot = structuredClone(task)
      void executeTask(exec, session).catch((error) => onError('A2A background execution failed', error))
      return snapshot
    }
    return executeTask(exec, session)
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
          store.setStatus(task, 'TASK_STATE_CANCELED')
          executions.get(task.id)?.cancel()
          // 取消不经 runMessage 的 emit 路径，需显式广播（SSE 订阅者与 webhook 都要看到终态）
          broadcast(task.id, { statusUpdate: { taskId: task.id, contextId: task.contextId, status: structuredClone(task.status) } })
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
        case 'CreateTaskPushNotificationConfig': {
          requirePushSupport()
          const config = parsePushConfig(params)
          if (typeof config.taskId !== 'string' || config.taskId.length === 0) {
            throw a2aError(INVALID_PARAMS, 'INVALID_ARGUMENT', 'params.taskId required')
          }
          requireTask(store, config.taskId)
          sendResult(res, rpc.id, structuredClone(pushStore.put(config)))
          return
        }
        case 'GetTaskPushNotificationConfig': {
          requirePushSupport()
          const taskId = requireStringParam(params, 'taskId')
          const id = requireStringParam(params, 'id')
          requireTask(store, taskId)
          const config = pushStore.get(taskId, id)
          if (config === undefined) {
            throw a2aError(TASK_NOT_FOUND, 'TASK_NOT_FOUND', `Push notification config not found: ${id}`, { taskId, id })
          }
          sendResult(res, rpc.id, structuredClone(config))
          return
        }
        case 'ListTaskPushNotificationConfigs': {
          requirePushSupport()
          const taskId = requireStringParam(params, 'taskId')
          requireTask(store, taskId)
          const all = pushStore.list(taskId)
          const pageSize = typeof params.pageSize === 'number' && Number.isFinite(params.pageSize)
            ? Math.min(Math.max(params.pageSize, 1), 100)
            : 50
          const offset = typeof params.pageToken === 'string' && params.pageToken.length > 0
            ? Number.parseInt(params.pageToken, 36) || 0
            : 0
          const page = all.slice(offset, offset + pageSize)
          const hasMore = offset + pageSize < all.length
          sendResult(res, rpc.id, {
            configs: structuredClone(page),
            nextPageToken: hasMore ? (offset + pageSize).toString(36) : '',
          })
          return
        }
        case 'DeleteTaskPushNotificationConfig': {
          requirePushSupport()
          const taskId = requireStringParam(params, 'taskId')
          const id = requireStringParam(params, 'id')
          if (!pushStore.delete(taskId, id)) {
            throw a2aError(TASK_NOT_FOUND, 'TASK_NOT_FOUND', `Push notification config not found: ${id}`, { taskId, id })
          }
          sendResult(res, rpc.id, {})
          return
        }
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

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
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

  return { handle, attachTask, executeTask }
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
  return createA2ACore(options).handle
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

/** Read one required string RPC parameter, or raise the protocol's argument error. */
function requireStringParam(params: Record<string, unknown>, field: string): string {
  const value = params[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw a2aError(INVALID_PARAMS, 'INVALID_ARGUMENT', `params.${field} required`)
  }
  return value
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
  const host = options.host ?? '127.0.0.1'
  const apiKey = options.apiKey ?? ''
  // 鉴权 fail-closed：非回环绑定必须带非空 key（本地回环开发可留空）
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (apiKey.length === 0 && !isLoopback) {
    throw new Error('A2A server bound to a non-loopback address requires a non-empty apiKey')
  }
  const store = options.store ?? new TaskStore()
  const core = createA2ACore({ ...options, store })
  const server = http.createServer(core.handle)
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      resolve()
    })
    server.once('error', reject)
  })
  // A failed bind must not crash the process before the owner awaits `ready`.
  ready.catch(() => {})
  server.listen(options.port, host)
  return {
    server,
    store,
    attachTask: core.attachTask,
    executeTask: core.executeTask,
    ready,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}
