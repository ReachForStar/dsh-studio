// A2A v1.0.1 手写实现：JSON-RPC 2.0 over HTTP(S) + SSE 流式 + push notification（webhook）。
// 线格式对齐 a2aproject/A2A@v1.0.1（a2a.proto 的 ProtoJSON；参考实现 a2a-js）。
// 方法：SendMessage / SendStreamingMessage / GetTask / ListTasks / CancelTask / SubscribeToTask /
//       GetExtendedAgentCard / Create|Get|List|DeleteTaskPushNotificationConfig。
// 未声明 capabilities.pushNotifications 时，push 配置 4 个方法返回
// UNSUPPORTED_OPERATION（reason PushNotificationNotSupportedError）。
import http from "node:http";
import { randomUUID } from "node:crypto";
import type {
  A2APart,
  A2AMessage,
  A2ATask,
  A2ATaskStatus,
  A2AStreamEvent,
  AgentCard,
  TaskPushNotificationConfig,
  TaskState,
} from "./schema.js";
import { isTerminal, textOf } from "./schema.js";

// ---------- 执行器接口（网关实现） ----------

export interface StreamSink {
  /** v1.0 无 final 参数；终态由服务端在 executor 返回后统一置 */
  sendStatus(state: TaskState, text?: string): void;
  /** 追加增量文本到 artifact（服务端累积；客户端流式打印） */
  appendArtifact(artifactId: string, name: string, text: string, lastChunk?: boolean): void;
}

/** 多路 sink（总线入口：同一份状态既要发 Kafka 也要写 A2A 任务表并触发 push 投递） */
export function teeSink(...sinks: StreamSink[]): StreamSink {
  return {
    sendStatus(state, text) {
      for (const s of sinks) s.sendStatus(state, text);
    },
    appendArtifact(artifactId, name, text, lastChunk) {
      for (const s of sinks) s.appendArtifact(artifactId, name, text, lastChunk);
    },
  };
}

export interface ExecutorContext {
  taskId: string;
  contextId: string;
  skill: string;
  workspace?: string;
  text: string;
  metadata: Record<string, unknown>;
  sink: StreamSink;
  signal?: AbortSignal;
}

export interface A2AExecutor {
  /** 执行一轮用户消息；resolve = 执行完成（服务端自动置 COMPLETED，抛错置 FAILED） */
  onMessage(ctx: ExecutorContext): Promise<void>;
  onCancel?(ctx: { taskId: string; contextId: string }): void | Promise<void>;
}

/** SendMessage/SendStreamingMessage 的 configuration 子集（服务端已实现的字段） */
export interface SendConfiguration {
  returnImmediately?: boolean;
  historyLength?: number;
  /** 发送时内联注册 push 配置；规范要求此时 taskId 留空，由服务端按任务填 */
  taskPushNotificationConfig?: TaskPushNotificationConfig;
}

// ---------- 错误（v1.0：JSON-RPC code + data 内 google.rpc.ErrorInfo） ----------

class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}
function rpcError(code: number, message: string, data?: unknown): RpcError {
  return new RpcError(code, message, data);
}
/** A2A 协议错误：data 携带 ErrorInfo（reason 大写蛇形 + domain） */
function a2aError(code: number, reason: string, message: string, metadata?: Record<string, unknown>): RpcError {
  return rpcError(code, message, [
    { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "a2a-protocol.org", ...(metadata ? { metadata } : {}) },
  ]);
}

const E_TASK_NOT_FOUND = -32001;
// v1.0.1 规范 §5.4：PushNotificationNotSupportedError = -32003（-32004 留给 UnsupportedOperationError）
const E_PUSH_NOT_SUPPORTED = -32003;
// 规范未定义鉴权失败错误码；取应用保留段（-32000..-32099）内未被规范占用的 -32010，避免 -32001 的 TaskNotFound 语义
const E_UNAUTHORIZED = -32010;
/** webhook 单次投递超时（防慢接收方拖住网关） */
const PUSH_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 任务存储 ----------

class TaskStore {
  private tasks = new Map<string, A2ATask>();
  private byContext = new Map<string, string[]>();
  private maxHistory = 20;
  /** 长驻网关内存防护：任务表上限，超出从最老的终态任务淘汰 */
  private maxTasks = 500;
  /** 任务淘汰回调（服务端用于清理该任务的 push 配置，防配置表无界增长） */
  onEvict?: (taskId: string) => void;

  get(id: string): A2ATask | undefined {
    return this.tasks.get(id);
  }
  create(contextId?: string, metadata?: Record<string, unknown>): A2ATask {
    return this.ensureTask(randomUUID(), contextId, metadata);
  }
  /** 按 id 取或建（总线入口用：调用方已生成 taskId，且可能因重投递而已存在） */
  ensureTask(id: string, contextId?: string, metadata?: Record<string, unknown>): A2ATask {
    const existing = this.tasks.get(id);
    if (existing) return existing;
    const ctx = contextId ?? randomUUID();
    const task: A2ATask = {
      id,
      contextId: ctx,
      status: { state: "TASK_STATE_SUBMITTED", timestamp: now() },
      artifacts: [],
      history: [],
      metadata,
    };
    this.tasks.set(id, task);
    const list = this.byContext.get(ctx) ?? [];
    list.push(id);
    this.byContext.set(ctx, list);
    this.evict();
    return task;
  }
  private evict(): void {
    if (this.tasks.size <= this.maxTasks) return;
    for (const [id, t] of this.tasks) {
      if (this.tasks.size <= this.maxTasks) break;
      if (!isTerminal(t.status.state)) continue;
      this.tasks.delete(id);
      this.onEvict?.(id);
      const list = this.byContext.get(t.contextId);
      if (list) {
        const i = list.indexOf(id);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) this.byContext.delete(t.contextId);
      }
    }
  }
  list(filter?: { contextId?: string; status?: TaskState }, pageSize = 50, includeArtifacts = false): A2ATask[] {
    let all = [...this.tasks.values()];
    if (filter?.contextId) all = all.filter((t) => t.contextId === filter.contextId);
    if (filter?.status) all = all.filter((t) => t.status.state === filter.status);
    return all.slice(0, Math.min(Math.max(pageSize, 1), 100)).map((t) =>
      includeArtifacts ? t : ({ ...t, artifacts: [] }),
    );
  }
  listAll(): A2ATask[] {
    return [...this.tasks.values()];
  }
  pushHistory(task: A2ATask, msg: A2AMessage): void {
    task.history.push(msg);
    if (task.history.length > this.maxHistory) task.history.splice(0, task.history.length - this.maxHistory);
  }
  setStatus(task: A2ATask, state: TaskState, text?: string): void {
    const status: A2ATaskStatus = { state, timestamp: now() };
    if (text) {
      status.message = {
        messageId: randomUUID(),
        contextId: task.contextId,
        taskId: task.id,
        role: "ROLE_AGENT",
        parts: [{ text }],
      };
    }
    task.status = status;
  }
  appendArtifact(task: A2ATask, artifactId: string, name: string, text: string): void {
    let art = task.artifacts.find((a) => a.artifactId === artifactId);
    if (!art) {
      art = { artifactId, name, parts: [] };
      task.artifacts.push(art);
    }
    const last = art.parts[art.parts.length - 1];
    if (last && last.text !== undefined) last.text += text;
    else art.parts.push({ text });
  }
}

/** Push 配置存储：按 taskId 分桶，配置 id 为资源标识（缺省生成 UUID） */
class PushConfigStore {
  private byTask = new Map<string, Map<string, TaskPushNotificationConfig>>();

  put(input: TaskPushNotificationConfig): TaskPushNotificationConfig {
    const taskId = input.taskId as string;
    const id = input.id || randomUUID();
    const cfg: TaskPushNotificationConfig = { ...input, id, taskId };
    const bucket = this.byTask.get(taskId) ?? new Map<string, TaskPushNotificationConfig>();
    bucket.set(id, cfg);
    this.byTask.set(taskId, bucket);
    return cfg;
  }
  get(taskId: string, id: string): TaskPushNotificationConfig | undefined {
    return this.byTask.get(taskId)?.get(id);
  }
  list(taskId: string): TaskPushNotificationConfig[] {
    return [...(this.byTask.get(taskId)?.values() ?? [])];
  }
  delete(taskId: string, id: string): boolean {
    const bucket = this.byTask.get(taskId);
    if (!bucket) return false;
    const ok = bucket.delete(id);
    if (!bucket.size) this.byTask.delete(taskId);
    return ok;
  }
  dropTask(taskId: string): void {
    this.byTask.delete(taskId);
  }
}

function now(): string {
  return new Date().toISOString(); // 含毫秒（.sssZ），符合 v1.0 ISO 8601 要求
}

// ---------- 服务端 ----------

export interface A2AServerOptions {
  port: number;
  host?: string;
  apiKey: string;
  card: AgentCard;
  executor: A2AExecutor;
  store?: TaskStore;
  taskTimeoutMs?: number;
}

export interface A2AServer {
  server: http.Server;
  store: TaskStore;
  /** 非 RPC 入口（Kafka 总线消费）用：按调用方给定 taskId 落库，返回与 RPC 路径同一套 sink，
   *  使总线任务在 GetTask/ListTasks/push 投递上行为一致（否则总线任务对 A2A 面不可见） */
  attachTask(input: { taskId: string; contextId: string; metadata?: Record<string, unknown> }): TaskSession;
  /** 执行一轮；suppliedSession 供总线入口传入 attachTask 建好的会话（终态统一由该会话落，调用方勿重复 finish/fail） */
  executeTask(ctx: Omit<ExecutorContext, "sink"> & { sink?: StreamSink }, suppliedSession?: TaskSession): Promise<A2ATask>;
  /** 端口真正 bind 成功时 resolve；监听失败（如端口占用）时 reject */
  ready: Promise<void>;
  close(): Promise<void>;
}

/** 一个任务的执行期视图（执行器只能拿 sink，终态由 finish/fail 统一落） */
export interface TaskSession {
  /** 不经状态机广播一帧（如初始 task 快照） */
  emit(frame: A2AStreamEvent): void;
  sink: StreamSink;
  finish(): A2ATask;
  fail(e: unknown): A2ATask;
}

interface MsgIn {
  contextId?: string;
  taskId?: string;
  role: string;
  parts?: A2APart[];
  metadata?: Record<string, unknown>;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export function createA2AServer(opts: A2AServerOptions): A2AServer {
  const store = opts.store ?? new TaskStore();
  const host = opts.host ?? "127.0.0.1";
  const taskTimeoutMs = opts.taskTimeoutMs ?? 600_000;
  if (!Number.isFinite(taskTimeoutMs) || taskTimeoutMs <= 0 || taskTimeoutMs > 2_147_483_647) {
    throw new Error("taskTimeoutMs 必须是 1 到 2147483647 之间的毫秒数");
  }
  // 鉴权 fail-closed：非回环绑定必须带 key（本地 127.0.0.1 开发可留空，启动时警告）
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!opts.apiKey && !isLoopback) {
    throw new Error("非回环绑定必须提供非空 apiKey（鉴权不可禁用）");
  }
  if (!opts.apiKey) {
    console.warn("[a2a] 警告: apiKey 为空，鉴权已禁用，仅回环地址下安全");
  }
  const executions = new Map<string, { promise: Promise<A2ATask>; cancel(): void }>();
  // SubscribeToTask 用：任务级事件广播（运行中的任务事件转发给订阅者）
  const taskSubs = new Map<string, Set<(f: A2AStreamEvent) => void>>();
  // 未结束的 SSE 响应（SendStreamingMessage / SubscribeToTask）：close() 时主动关闭，否则 server.close() 永不 resolve
  const activeSse = new Set<http.ServerResponse>();
  // push 配置与任务同生命周期；能力按卡片声明（未声明则 4 个方法一律拒绝）
  // 投递序：每配置一条 Promise 链（见 enqueuePush）
  const pushQueues = new Map<string, Promise<void>>();
  const pushStore = new PushConfigStore();
  store.onEvict = (taskId) => {
    pushStore.dropTask(taskId);
    for (const key of [...pushQueues.keys()]) if (key.startsWith(`${taskId}/`)) pushQueues.delete(key);
  };
  const pushEnabled = opts.card.capabilities?.pushNotifications === true;

  function requirePushSupport(): void {
    if (pushEnabled) return;
    throw a2aError(E_PUSH_NOT_SUPPORTED, "PushNotificationNotSupportedError", "本 agent 未声明 capabilities.pushNotifications");
  }

  /** 投递请求头：规范定义 Content-Type + Authorization；token 头为旧版（v0.3）惯例，v1.0.1 未定义传输位置 */
  function pushHeaders(cfg: TaskPushNotificationConfig): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/a2a+json" };
    if (cfg.authentication?.scheme) {
      h.Authorization = cfg.authentication.credentials
        ? `${cfg.authentication.scheme} ${cfg.authentication.credentials}`
        : cfg.authentication.scheme;
    }
    if (cfg.token) h["X-A2A-Notification-Token"] = cfg.token;
    return h;
  }

  /** 投递一帧：至少一次（网络错误/5xx 再试一次），10s 超时；失败不影响任务本身，只记日志 */
  async function deliverPush(cfg: TaskPushNotificationConfig, payload: string, attempt = 1): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PUSH_TIMEOUT_MS);
    let retryable = false;
    let detail = "";
    try {
      const res = await fetch(cfg.url, { method: "POST", headers: pushHeaders(cfg), body: payload, signal: ctrl.signal });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return;
      retryable = res.status >= 500;
      detail = `HTTP ${res.status}`;
    } catch (e) {
      retryable = true;
      detail = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    if (retryable && attempt < 2) {
      await sleep(500);
      return deliverPush(cfg, payload, attempt + 1);
    }
    console.error(`[a2a] push 投递失败（尝试 ${attempt} 次）→ ${cfg.url} taskId=${cfg.taskId}: ${detail}`);
  }

  /** 任务事件出口：SSE 订阅者 + 已注册 webhook（投递异步，不阻塞任务执行） */
  function broadcast(taskId: string, frame: A2AStreamEvent): void {
    for (const fn of taskSubs.get(taskId) ?? []) {
      try {
        fn(frame);
      } catch {
        /* 订阅者写失败（已断开）忽略 */
      }
    }
    const cfgs = pushStore.list(taskId);
    if (!cfgs.length) return;
    const payload = JSON.stringify(frame);
    for (const cfg of cfgs) enqueuePush(cfg, payload);
  }

  /** 每配置一条串行投递链：规范要求事件按生成顺序投递，并发 POST 会乱序 */
  function enqueuePush(cfg: TaskPushNotificationConfig, payload: string): void {
    const key = `${cfg.taskId}/${cfg.id}`;
    const next = (pushQueues.get(key) ?? Promise.resolve())
      .then(() => deliverPush(cfg, payload))
      .catch(() => {});
    pushQueues.set(key, next);
    void next.finally(() => {
      if (pushQueues.get(key) === next) pushQueues.delete(key);
    });
  }

  /** 任务执行期视图：状态/工件写库 + 广播（A2A RPC 与总线入口共用同一套语义） */
  function taskSession(task: A2ATask, onEvent?: (f: A2AStreamEvent) => void): TaskSession {
    subsOf(task.id);
    const emit = (f: A2AStreamEvent): void => {
      onEvent?.(f);
      broadcast(task.id, f);
    };
    const statusFrame = (): A2AStreamEvent => ({
      statusUpdate: { taskId: task.id, contextId: task.contextId, status: { ...task.status } },
    });
    let finished = false;
    return {
      emit,
      sink: {
        sendStatus(state, text) {
          if (finished || isTerminal(task.status.state)) return;
          store.setStatus(task, state, text);
          emit(statusFrame());
        },
        appendArtifact(artifactId, name, text, lastChunk) {
          if (finished || isTerminal(task.status.state)) return;
          store.appendArtifact(task, artifactId, name, text);
          emit({
            artifactUpdate: {
              taskId: task.id,
              contextId: task.contextId,
              artifact: { artifactId, name, parts: [{ text }] },
              append: true,
              lastChunk,
            },
          });
        },
      },
      finish() {
        if (!finished && !isTerminal(task.status.state)) {
          store.setStatus(task, "TASK_STATE_COMPLETED");
          emit(statusFrame());
        }
        finished = true;
        taskSubs.delete(task.id);
        return clone(task);
      },
      fail(e) {
        if (!finished && !isTerminal(task.status.state)) {
          store.setStatus(task, "TASK_STATE_FAILED", e instanceof Error ? e.message : String(e));
          emit(statusFrame());
        }
        finished = true;
        taskSubs.delete(task.id);
        return clone(task);
      },
    };
  }

  /** 总线等非 RPC 入口：按调用方给定 taskId 落库并返回同一套 sink */
  function attachTask(input: { taskId: string; contextId: string; metadata?: Record<string, unknown> }): TaskSession {
    return taskSession(store.ensureTask(input.taskId, input.contextId, input.metadata));
  }

  function authed(req: http.IncomingMessage): boolean {
    if (!opts.apiKey) return true;
    return req.headers["x-api-key"] === opts.apiKey;
  }

  function skillOf(msg: MsgIn): string {
    return (
      (msg.metadata?.skill as string) ??
      (msg.parts?.[0] && (msg.parts[0].metadata?.skill as string)) ??
      "default"
    );
  }

  /** 执行一轮：创建/复用任务，调 executor，落任务状态。返回终态任务。 */
  async function runMessage(
    msg: MsgIn,
    configuration?: SendConfiguration,
    live?: (ev: A2AStreamEvent) => void,
  ): Promise<A2ATask> {
    const text = textOf(msg.parts);
    let task = msg.taskId ? store.get(msg.taskId) : undefined;
    if (msg.taskId && !task) throw a2aError(E_TASK_NOT_FOUND, "TASK_NOT_FOUND", `Task not found: ${msg.taskId}`, { taskId: msg.taskId });
    if (!task) task = store.create(msg.contextId, msg.metadata);
    // 内联 push 配置：必须在首个事件发出前注册，否则 SUBMITTED 帧投不出去
    const inlinePush = configuration?.taskPushNotificationConfig;
    if (inlinePush) {
      requirePushSupport();
      if (!inlinePush.url) throw a2aError(-32602, "INVALID_ARGUMENT", "configuration.taskPushNotificationConfig.url required");
      pushStore.put({ ...inlinePush, taskId: task.id });
    }
    // 每次发送都落 history（含已有 taskId 的续聊）
    store.pushHistory(task, {
      messageId: randomUUID(),
      contextId: task.contextId,
      taskId: task.id,
      role: "ROLE_USER",
      parts: msg.parts ?? [],
      metadata: msg.metadata,
    });

    // 任务级广播容器（SubscribeToTask 也会惰性建）；终态时清理
    const session = taskSession(task, live);

    store.setStatus(task, "TASK_STATE_SUBMITTED");
    session.emit({ task: clone(task) });

    const exec = { taskId: task.id, contextId: task.contextId, skill: skillOf(msg), text, metadata: msg.metadata ?? {} };
    if (configuration?.returnImmediately) {
      const snapshot = clone(task);
      void executeTask(exec, session).catch((e) => console.error("[a2a] 后台执行失败:", e));
      return snapshot;
    }
    return executeTask(exec, session);
  }

  function executeTask(ctx: Omit<ExecutorContext, "sink"> & { sink?: StreamSink }, suppliedSession?: TaskSession): Promise<A2ATask> {
    const task = ctx.taskId
      ? store.ensureTask(ctx.taskId, ctx.contextId, ctx.metadata)
      : store.create(ctx.contextId, ctx.metadata);
    if (isTerminal(task.status.state)) return Promise.resolve(clone(task));
    const existing = executions.get(task.id);
    if (existing) return existing.promise;
    const session = suppliedSession ?? taskSession(task);
    const ctrl = new AbortController();
    let settled = false;
    let rejectStopped!: (e: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    const cancel = (e = new Error("任务已取消")): void => {
      if (ctrl.signal.aborted || settled) return;
      rejectStopped(e);
      ctrl.abort(e);
      void Promise.resolve().then(() => opts.executor.onCancel?.({ taskId: task.id, contextId: task.contextId }))
        .catch((error) => console.error(`[a2a] onCancel 失败 taskId=${task.id}:`, error));
    };
    const sink: StreamSink = {
      sendStatus(state, text) {
        if (settled || ctrl.signal.aborted || isTerminal(task.status.state)) return;
        session.sink.sendStatus(state, text);
        ctx.sink?.sendStatus(state, text);
      },
      appendArtifact(id, name, text, lastChunk) {
        if (settled || ctrl.signal.aborted || isTerminal(task.status.state)) return;
        session.sink.appendArtifact(id, name, text, lastChunk);
        ctx.sink?.appendArtifact(id, name, text, lastChunk);
      },
    };
    const timer = setTimeout(() => cancel(new Error(`任务执行超时 (${taskTimeoutMs}ms)`)), taskTimeoutMs);
    const work = Promise.resolve().then(() => {
      ctrl.signal.throwIfAborted();
      sink.sendStatus("TASK_STATE_SUBMITTED");
      return opts.executor.onMessage({ ...ctx, sink, signal: ctrl.signal });
    });
    const p = Promise.race([work, stopped])
      .then(() => session.finish(), (e) => session.fail(e))
      .finally(() => {
        settled = true;
        clearTimeout(timer);
        executions.delete(task.id);
      });
    executions.set(task.id, { promise: p, cancel });
    return p;
  }

  /** 入参类型校验（入口边界防护；失败抛 -32602 INVALID_ARGUMENT） */
  function reqStr(params: Record<string, unknown>, field: string): string {
    const v = params[field];
    if (typeof v !== "string" || !v) throw a2aError(-32602, "INVALID_ARGUMENT", `params.${field} 必填非空字符串`);
    return v;
  }
  function optStr(params: Record<string, unknown>, field: string): string | undefined {
    const v = params[field];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw a2aError(-32602, "INVALID_ARGUMENT", `params.${field} 须为字符串`);
    return v;
  }
  function optObject(params: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
    const v = params[field];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "object" || Array.isArray(v)) throw a2aError(-32602, "INVALID_ARGUMENT", `params.${field} 须为对象`);
    return v as Record<string, unknown>;
  }
  function reqMessage(params: Record<string, unknown>): MsgIn {
    const msg = params.message;
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw a2aError(-32602, "INVALID_ARGUMENT", "params.message 须为对象");
    const m = msg as MsgIn;
    if (!Array.isArray(m.parts) || !m.parts.length) throw a2aError(-32602, "INVALID_ARGUMENT", "params.message.parts 必填非空数组");
    if (m.role !== "ROLE_USER") throw a2aError(-32602, "INVALID_ARGUMENT", "params.message.role 须为 ROLE_USER");
    return m;
  }

  async function handleRpc(req: http.IncomingMessage, res: http.ServerResponse, body: string): Promise<void> {
    let rpc: { jsonrpc: string; id: string | number | null; method: string; params?: Record<string, unknown> };
    try {
      rpc = JSON.parse(body);
    } catch {
      return jsonRpcError(res, null, -32700, "Parse error");
    }
    if (rpc.jsonrpc !== "2.0" || !rpc.method) {
      return jsonRpcError(res, rpc.id ?? null, -32600, "Invalid request");
    }
    if (rpc.params !== undefined && (typeof rpc.params !== "object" || Array.isArray(rpc.params))) {
      return jsonRpcError(res, rpc.id ?? null, -32602, "Invalid params (object expected)");
    }
    const params = (rpc.params ?? {}) as Record<string, unknown>;
    try {
      switch (rpc.method) {
        case "SendMessage": {
          const msg = reqMessage(params);
          const configuration = optObject(params, "configuration") as SendConfiguration | undefined;
          const task = await runMessage(msg, configuration);
          return jsonRpcResult(res, rpc.id, { task: clone(task) });
        }
        case "SendStreamingMessage": {
          const msg = reqMessage(params);
          const cfg = optObject(params, "configuration") as SendConfiguration | undefined;
          // 流式绑定恒等终态才关流；returnImmediately 仅对非流式 SendMessage 生效，流式路径忽略之
          // （否则“快照后即关流”会让客户端把 returnImmediately 任务误判为截断）
          const configuration = cfg ? { ...cfg, returnImmediately: undefined } : undefined;
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          activeSse.add(res);
          let closed = false;
          res.on("close", () => {
            closed = true;
            activeSse.delete(res);
          });
          const sendFrame = (obj: unknown): void => {
            if (closed || res.writableEnded || res.destroyed) return;
            try {
              res.write(`data: ${JSON.stringify(obj)}\n\n`);
            } catch {
              closed = true;
            }
          };
          try {
            await runMessage(msg, configuration, sendFrame);
          } catch (e) {
            // 头已发出，错误只能用 SSE 帧承载；若落回外层 catch 会二次 writeHead 崩进程
            sendFrame({
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: e instanceof RpcError ? e.code : -32603, message: e instanceof Error ? e.message : String(e) },
            });
          }
          // v1.0：终态后直接关流（无 [DONE] 约定，无 final 字段）
          if (!closed) res.end();
          return;
        }
        case "GetTask": {
          const id = reqStr(params, "id");
          const task = store.get(id);
          if (!task) throw a2aError(E_TASK_NOT_FOUND, "TASK_NOT_FOUND", `Task not found: ${id}`, { taskId: id });
          const hl = params.historyLength;
          if (hl !== undefined && (typeof hl !== "number" || !Number.isFinite(hl) || hl < 0)) {
            throw a2aError(-32602, "INVALID_ARGUMENT", "params.historyLength 须为非负数");
          }
          const out = hl !== undefined ? { ...clone(task), history: task.history.slice(-Math.max(hl, 0)) } : clone(task);
          return jsonRpcResult(res, rpc.id, out);
        }
        case "ListTasks": {
          const pageSizeRaw = params.pageSize;
          if (pageSizeRaw !== undefined && (typeof pageSizeRaw !== "number" || !Number.isFinite(pageSizeRaw))) {
            throw a2aError(-32602, "INVALID_ARGUMENT", "params.pageSize 须为数字");
          }
          const pageSize = Math.min(Math.max((pageSizeRaw as number) ?? 50, 1), 100);
          const offset = optStr(params, "pageToken") ? Number.parseInt(String(params.pageToken), 36) || 0 : 0;
          const contextId = optStr(params, "contextId");
          const status = optStr(params, "status");
          let all = store.listAll();
          if (contextId) all = all.filter((t) => t.contextId === contextId);
          if (status) all = all.filter((t) => t.status.state === status);
          const page = all.slice(offset, offset + pageSize).map((t) =>
            params.includeArtifacts ? clone(t) : { ...clone(t), artifacts: [] },
          );
          const hasMore = offset + pageSize < all.length;
          return jsonRpcResult(res, rpc.id, {
            tasks: page,
            nextPageToken: hasMore ? (offset + pageSize).toString(36) : "",
            pageSize: page.length,
            totalSize: all.length,
          });
        }
        case "CancelTask": {
          const id = reqStr(params, "id");
          const task = store.get(id);
          if (!task) throw a2aError(E_TASK_NOT_FOUND, "TASK_NOT_FOUND", `Task not found: ${id}`, { taskId: id });
          if (isTerminal(task.status.state)) return jsonRpcResult(res, rpc.id, clone(task));

          store.setStatus(task, "TASK_STATE_CANCELED");
          executions.get(task.id)?.cancel();
          // 取消不经 runMessage 的 emit 路径，需显式广播（SSE 订阅者与 webhook 都要看到终态）
          broadcast(task.id, { statusUpdate: { taskId: task.id, contextId: task.contextId, status: { ...task.status } } });
          return jsonRpcResult(res, rpc.id, clone(task));
        }
        case "SubscribeToTask": {
          const id = reqStr(params, "id");
          const task = store.get(id);
          if (!task) throw a2aError(E_TASK_NOT_FOUND, "TASK_NOT_FOUND", `Task not found: ${id}`, { taskId: id });
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          activeSse.add(res);
          let closed = false;
          res.on("close", () => {
            closed = true;
            activeSse.delete(res);
          });
          const sendFrame = (obj: unknown): void => {
            if (closed || res.writableEnded || res.destroyed) return;
            try {
              res.write(`data: ${JSON.stringify(obj)}\n\n`);
            } catch {
              closed = true;
            }
          };
          sendFrame({ task: clone(task) });
          if (isTerminal(task.status.state)) {
            res.end();
            return;
          }
          // 运行中任务：广播当前任务的事件直到终态（或超时兜底）
          await new Promise<void>((resolve) => {
            const frame = (f: A2AStreamEvent): void => {
              sendFrame(f);
              if ("statusUpdate" in f && isTerminal(f.statusUpdate.status.state)) {
                subsOf(task.id).delete(frame);
                resolve();
              }
            };
            const s = subsOf(task.id);
            s.add(frame);
            // 订阅前任务刚好终态（runMessage 已清理 subs）：补发终态帧后结束
            const cur = store.get(task.id);
            if (!cur || isTerminal(cur.status.state) || taskSubs.get(task.id) !== s) {
              s.delete(frame);
              if (cur) sendFrame({ statusUpdate: { taskId: cur.id, contextId: cur.contextId, status: cur.status } });
              resolve();
            }
            setTimeout(() => {
              s.delete(frame);
              resolve();
            }, 10 * 60 * 1000).unref();
          });
          if (!closed) res.end();
          return;
        }
        case "GetExtendedAgentCard": {
          return jsonRpcResult(res, rpc.id, clone(opts.card));
        }
        case "CreateTaskPushNotificationConfig": {
          requirePushSupport();
          const cfg = params as unknown as TaskPushNotificationConfig;
          if (typeof cfg?.url !== "string" || !cfg.url) throw a2aError(-32602, "INVALID_ARGUMENT", "params.url required");
          if (typeof cfg?.taskId !== "string" || !cfg.taskId) throw a2aError(-32602, "INVALID_ARGUMENT", "params.taskId required");
          if (!store.get(cfg.taskId)) {
            throw a2aError(E_TASK_NOT_FOUND, "TASK_NOT_FOUND", `Task not found: ${cfg.taskId}`, { taskId: cfg.taskId });
          }
          return jsonRpcResult(res, rpc.id, clone(pushStore.put(cfg)));
        }
        case "GetTaskPushNotificationConfig": {
          requirePushSupport();
          const taskId = reqStr(params, "taskId");
          const id = reqStr(params, "id");
          if (!store.get(taskId)) throw a2aError(E_TASK_NOT_FOUND, "TASK_NOT_FOUND", `Task not found: ${taskId}`, { taskId });
          const cfg = pushStore.get(taskId, id);
          if (!cfg) throw a2aError(E_TASK_NOT_FOUND, "TASK_NOT_FOUND", `Push notification config not found: ${id}`, { taskId, id });
          return jsonRpcResult(res, rpc.id, clone(cfg));
        }
        case "ListTaskPushNotificationConfigs": {
          requirePushSupport();
          const taskId = reqStr(params, "taskId");
          const pageSizeRaw = params.pageSize;
          if (pageSizeRaw !== undefined && (typeof pageSizeRaw !== "number" || !Number.isFinite(pageSizeRaw))) {
            throw a2aError(-32602, "INVALID_ARGUMENT", "params.pageSize 须为数字");
          }
          if (!store.get(taskId)) throw a2aError(E_TASK_NOT_FOUND, "TASK_NOT_FOUND", `Task not found: ${taskId}`, { taskId });
          const all = pushStore.list(taskId);
          const size = Math.min(Math.max((pageSizeRaw as number) ?? 50, 1), 100);
          const offset = optStr(params, "pageToken") ? Number.parseInt(String(params.pageToken), 36) || 0 : 0;
          const page = all.slice(offset, offset + size);
          const hasMore = offset + size < all.length;
          return jsonRpcResult(res, rpc.id, {
            configs: clone(page),
            nextPageToken: hasMore ? (offset + size).toString(36) : "",
          });
        }
        case "DeleteTaskPushNotificationConfig": {
          requirePushSupport();
          const taskId = reqStr(params, "taskId");
          const id = reqStr(params, "id");
          if (!pushStore.delete(taskId, id)) {
            throw a2aError(E_TASK_NOT_FOUND, "TASK_NOT_FOUND", `Push notification config not found: ${id}`, { taskId, id });
          }
          // 规范响应为 google.protobuf.Empty
          return jsonRpcResult(res, rpc.id, {});
        }
        default:
          throw rpcError(-32601, `Method not found: ${rpc.method}`);
      }
    } catch (e) {
      if (e instanceof RpcError) return jsonRpcError(res, rpc.id, e.code, e.message, e.data);
      return jsonRpcError(res, rpc.id, -32603, e instanceof Error ? e.message : String(e));
    }
  }

  function subsOf(taskId: string): Set<(f: A2AStreamEvent) => void> {
    const s = taskSubs.get(taskId) ?? new Set();
    taskSubs.set(taskId, s);
    return s;
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    // 健康检查（公开，无需鉴权；供网关存活探测）
    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, agent: opts.card.name }));
      return;
    }
    // Agent Card 发现（公开，无需鉴权）
    if (req.method === "GET" && (url === "/.well-known/agent-card.json" || url === "/.well-known/agent.json")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(opts.card, null, 2));
      return;
    }
    if (req.method === "POST") {
      if (!authed(req)) {
        const ue = a2aError(E_UNAUTHORIZED, "UnauthorizedError", "unauthorized");
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: ue.code, message: ue.message, data: ue.data } }));
        return;
      }
      // 长驻网关内存防护：请求体上限 1MB，超出直接 413 并断开
      const MAX_BODY = 1024 * 1024;
      let body = "";
      let rejected = false;
      req.on("data", (c: Buffer) => {
        if (rejected) return;
        body += c.toString();
        if (body.length > MAX_BODY) {
          rejected = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request body too large" } }));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (rejected) return;
        void handleRpc(req, res, body).catch((e) => {
          // 兜底：handleRpc 内任何未捕获异常不得崩进程
          console.error("[a2a] 处理请求失败:", e instanceof Error ? e : String(e));
          if (!res.headersSent) jsonRpcError(res, null, -32603, e instanceof Error ? e.message : String(e));
        });
      });
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (e) => reject(e));
  });
  // 监听失败可能发生在 main() 开始 await ready 之前（如 startGateway 内部的 await 间隙），
  // 未观察的 rejection 会直接崩进程；挂空 handler 标记为已处理，错误仍由 await 方接收
  ready.catch(() => {});
  server.listen(opts.port, host);

  return {
    server,
    store,
    attachTask,
    executeTask,
    ready,
    close: () => new Promise((r) => {
      // 先结束未关的 SSE 流，否则 server.close() 会等它们永远不 resolve
      for (const s of activeSse) s.end();
      server.close(() => r());
    }),
  };
}

function jsonRpcResult(res: http.ServerResponse, id: string | number | null, result: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
function jsonRpcError(res: http.ServerResponse, id: string | number | null, code: number, message: string, data?: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } }));
}

/** 客户端报错时带上 A2A 协议 reason（data[0].reason），便于调用方判断错误类别 */
function reasonOf(error: { data?: unknown }): string {
  const reason = (error.data as Array<{ reason?: string }> | undefined)?.[0]?.reason;
  return reason ? ` (${reason})` : "";
}

// ---------- 客户端 ----------

export class A2AClient {
  constructor(
    /** RPC 端点，如 http://127.0.0.1:9320/ */
    public url: string,
    private apiKey?: string,
    /** 请求-响应类 RPC（GetTask/配置 CRUD/agent card）的超时；流式接口任务时长不定，不受此限 */
    private rpcTimeoutMs = 30_000,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["X-Api-Key"] = this.apiKey;
    return h;
  }

  async getCard(): Promise<AgentCard> {
    const origin = new URL(this.url).origin;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.rpcTimeoutMs);
    try {
      const res = await fetch(`${origin}/.well-known/agent-card.json`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`agent card 获取失败: ${res.status}`);
      return (await res.json()) as AgentCard;
    } finally {
      clearTimeout(t);
    }
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.rpcTimeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        signal: ctrl.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      });
      const body = await res.json();
      if (body.error) throw new Error(`A2A ${method} 错误 ${body.error.code}${reasonOf(body.error)}: ${body.error.message}`);
      return body.result;
    } finally {
      clearTimeout(t);
    }
  }

  private messageParam(message: {
    contextId?: string;
    taskId?: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): A2AMessage {
    return {
      messageId: randomUUID(),
      contextId: message.contextId,
      taskId: message.taskId,
      role: "ROLE_USER",
      parts: [{ text: message.text }],
      metadata: message.metadata,
    };
  }

  /** 发送参数：message 必带，configuration 仅在需要时出现（内联 push 配置 / returnImmediately） */
  private sendParams(
    message: { contextId?: string; taskId?: string; text: string; metadata?: Record<string, unknown> },
    configuration?: SendConfiguration,
  ): Record<string, unknown> {
    return {
      message: this.messageParam(message),
      ...(configuration ? { configuration } : {}),
    };
  }

  /** SendMessage → result 为 oneof {task, message}，本实现服务端恒返回 task */
  async sendMessage(
    message: { contextId?: string; taskId?: string; text: string; metadata?: Record<string, unknown> },
    timeoutMs = 10 * 60 * 1000,
    configuration?: SendConfiguration,
  ): Promise<A2ATask> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        signal: ctrl.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "SendMessage",
          params: this.sendParams(message, configuration),
        }),
      });
      const body = await res.json();
      if (body.error) throw new Error(`A2A SendMessage 错误 ${body.error.code}: ${body.error.message}`);
      return (body.result as { task: A2ATask }).task;
    } finally {
      clearTimeout(t);
    }
  }

  /** SendStreamingMessage → SSE 逐帧产出 StreamResponse（task/message/statusUpdate/artifactUpdate）；流关闭 = 终态。
   * 首帧前遇到瞬态断连（terminated/ECONNREFUSED 等）无可见副作用，自动重试一次。 */
  async *sendMessageStream(
    message: { contextId?: string; taskId?: string; text: string; metadata?: Record<string, unknown> },
    configuration?: SendConfiguration,
  ): AsyncGenerator<A2AStreamEvent> {
    let yielded = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { ...this.headers(), Accept: "text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: randomUUID(),
            method: "SendStreamingMessage",
            params: this.sendParams(message, configuration),
          }),
        });
        if (!res.ok || !res.body) {
          const errText = await res.text();
          throw new Error(`A2A SendStreamingMessage HTTP ${res.status}: ${errText}`);
        }
        // 服务端未发 SSE 头就失败（如缺 parts）时返回 200 + JSON-RPC 错误体；识别后抛出，防静默空流
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const jbody = (await res.json()) as { error?: { code: number; message: string } };
          throw new Error(jbody.error ? `A2A SendStreamingMessage 错误 ${jbody.error.code}: ${jbody.error.message}` : `A2A SendStreamingMessage 意外返回 JSON: ${JSON.stringify(jbody)}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let terminal = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              // 流在未收到终态帧时关闭 = 截断（服务端崩溃/提前关流），不能静默吞掉
              if (!terminal) throw new Error("A2A SendStreamingMessage 流中断（未收到终态帧）");
              return;
            }
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              // SSE 规范：data 字段冒号后可无空格（只认 "data: " 会丢合法帧）
              for (const line of frame.split("\n")) {
                if (!line.startsWith("data:")) continue;
                let data = line.slice(5);
                if (data.startsWith(" ")) data = data.slice(1);
                if (!data) continue;
                const ev = JSON.parse(data) as A2AStreamEvent & { error?: { code: number; message: string } };
                // 服务端在 SSE 流内回传的 JSON-RPC 错误帧（如 taskId 不存在）
                if (ev.error) throw new Error(`A2A SendStreamingMessage 错误 ${ev.error.code}: ${ev.error.message}`);
                if ("statusUpdate" in ev && isTerminal(ev.statusUpdate.status.state)) terminal = true;
                yielded = true;
                yield ev as A2AStreamEvent;
              }
            }
          }
        } finally {
          // 生成器被提前放弃或异常退出时释放连接（不 cancel 会泄漏 socket 直到服务端超时）
          await reader.cancel().catch(() => {});
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const transient = ["terminated", "fetch failed", "ECONNREFUSED", "ECONNRESET", "socket hang up"].some((s) => msg.includes(s));
        if (yielded) {
          // 流已开始：中途断连（terminated/ECONNRESET 等异常关闭）= 截断（未收到终态帧），带原因上报，不重试
          if (transient) throw new Error(`A2A SendStreamingMessage 流中断（未收到终态帧）: ${msg}`);
          throw e;
        }
        // 只重试“首帧前”的瞬态断连（无副作用）；协议错误与流中断后续不重试
        if (attempt >= 1 || !transient) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  async createTaskPushNotificationConfig(cfg: TaskPushNotificationConfig): Promise<TaskPushNotificationConfig> {
    return (await this.rpc("CreateTaskPushNotificationConfig", cfg)) as TaskPushNotificationConfig;
  }

  async getTaskPushNotificationConfig(params: { taskId: string; id: string }): Promise<TaskPushNotificationConfig> {
    return (await this.rpc("GetTaskPushNotificationConfig", params)) as TaskPushNotificationConfig;
  }

  async listTaskPushNotificationConfigs(params: {
    taskId: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<{ configs: TaskPushNotificationConfig[]; nextPageToken: string }> {
    return (await this.rpc("ListTaskPushNotificationConfigs", params)) as {
      configs: TaskPushNotificationConfig[];
      nextPageToken: string;
    };
  }

  async deleteTaskPushNotificationConfig(params: { taskId: string; id: string }): Promise<void> {
    await this.rpc("DeleteTaskPushNotificationConfig", params);
  }

  async getTask(id: string): Promise<A2ATask> {
    return (await this.rpc("GetTask", { id })) as A2ATask;
  }

  async listTasks(filter?: { contextId?: string; status?: TaskState; pageSize?: number; pageToken?: string }): Promise<{ tasks: A2ATask[]; nextPageToken: string; totalSize: number }> {
    return (await this.rpc("ListTasks", filter ?? {})) as { tasks: A2ATask[]; nextPageToken: string; totalSize: number };
  }

  async cancelTask(id: string): Promise<A2ATask> {
    return (await this.rpc("CancelTask", { id })) as A2ATask;
  }
}
