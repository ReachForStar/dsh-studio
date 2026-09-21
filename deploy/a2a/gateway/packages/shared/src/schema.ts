// A2A v1.0.1 线格式类型（ProtoJSON：camelCase 字段、枚举全名；
// 规范来源 a2aproject/A2A@v1.0.1 specification/a2a.proto，参考实现 a2a-js）
export type TaskState =
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED";

export type Role = "ROLE_USER" | "ROLE_AGENT";

/** 统一 Part：oneof content（text/raw/url/data）由字段存在性区分，无 kind 判别字段 */
export interface A2APart {
  text?: string;
  raw?: string; // base64
  url?: string;
  data?: unknown;
  filename?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

export interface A2AMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: Role;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

export interface A2ATaskStatus {
  state: TaskState;
  message?: A2AMessage;
  /** ISO 8601 UTC 毫秒精度（YYYY-MM-DDTHH:mm:ss.sssZ） */
  timestamp: string;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  artifacts: A2AArtifact[];
  history: A2AMessage[];
  metadata?: Record<string, unknown>;
}

// ---------- 流式事件（SSE 帧 = StreamResponse oneof，按成员名区分，无 kind 字段） ----------

export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: A2ATaskStatus;
  metadata?: Record<string, unknown>;
  // v1.0 无 final 字段：终态由流关闭表示
}
export interface TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}
export type A2AStreamEvent =
  | { task: A2ATask }
  | { message: A2AMessage }
  | { statusUpdate: TaskStatusUpdateEvent }
  | { artifactUpdate: TaskArtifactUpdateEvent };

// ---------- Push Notification（webhook；规范 4.3） ----------

export interface PushNotificationAuthenticationInfo {
  /** HTTP 认证方案（IANA 注册表：Bearer / Basic / Digest…，大小写不敏感） */
  scheme: string;
  credentials?: string;
}

export interface TaskPushNotificationConfig {
  tenant?: string;
  /** 配置资源 id（缺省由服务端生成） */
  id?: string;
  /** 关联任务（内联注册时留空，服务端填实际 taskId） */
  taskId?: string;
  url: string;
  /** 任务/会话唯一 token；v1.0.1 未定义传输位置，兼容旧版经 X-A2A-Notification-Token 头回传 */
  token?: string;
  authentication?: PushNotificationAuthenticationInfo;
}

export interface GetTaskPushNotificationConfigParams {
  tenant?: string;
  taskId: string;
  id: string;
}

export interface ListTaskPushNotificationConfigsParams {
  tenant?: string;
  taskId: string;
  pageSize?: number;
  pageToken?: string;
}

export interface ListTaskPushNotificationConfigsResult {
  configs: TaskPushNotificationConfig[];
  nextPageToken: string;
}

// ---------- Agent Card（v1.0：url/protocolVersion 移入 supportedInterfaces） ----------

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentInterface {
  url: string;
  protocolBinding: string; // "JSONRPC" | "GRPC" | "HTTP+JSON"
  tenant?: string;
  protocolVersion: string; // "1.0"
}

export interface APIKeySecurityScheme {
  description?: string;
  location: "header" | "query" | "cookie";
  name: string;
}
export interface SecurityScheme {
  apiKeySecurityScheme?: APIKeySecurityScheme;
  [k: string]: unknown;
}

export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: AgentInterface[];
  provider?: { url: string; organization: string };
  version: string;
  documentationUrl?: string;
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    extendedAgentCard?: boolean;
  };
  securitySchemes?: Record<string, SecurityScheme>;
  securityRequirements?: Array<{ schemes: Record<string, { list: string[] }> }>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  iconUrl?: string;
}

// ---------- 总线消息（Kafka，自定义内部线格式，与 A2A 版本无关） ----------

export interface BusTask {
  schema: "a2a.task/1";
  taskId: string;
  contextId: string;
  from: string;
  to: string;
  skill: string;
  input: { text: string; workspace?: string };
  metadata?: Record<string, unknown>;
  ts: number;
  attempt: number;
}

export interface BusEvent {
  schema: "a2a.event/1";
  taskId: string;
  contextId: string;
  from: string; // 执行方 agent 名
  type: "status-update" | "artifact-update" | "terminal";
  state?: TaskState;
  text?: string; // 增量文本
  artifact?: string;
  final?: boolean;
  error?: string;
  ts: number;
}

export function textOf(parts: A2APart[] | undefined): string {
  if (!parts) return "";
  return parts.map((p) => p.text ?? "").join("");
}

export function isTerminal(state: TaskState): boolean {
  return (
    state === "TASK_STATE_COMPLETED" ||
    state === "TASK_STATE_FAILED" ||
    state === "TASK_STATE_CANCELED" ||
    state === "TASK_STATE_REJECTED"
  );
}
