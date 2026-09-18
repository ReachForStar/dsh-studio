/** Task lifecycle state, as the protocol names it. */
export type TaskState =
  | 'TASK_STATE_UNSPECIFIED'
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED'

/** The protocol version this implementation speaks, as `Major.Minor`. */
export const A2A_PROTOCOL_VERSION = '1.0'

/** Message author. */
export type Role = 'ROLE_USER' | 'ROLE_AGENT'

/**
 * One message or artifact part. The protocol's `content` oneof carries no
 * discriminant, so the present field decides the kind: exactly one of `text`,
 * `raw`, `url`, and `data` is set.
 */
export interface A2APart {
  /** Plain text content. */
  text?: string
  /** Base64-encoded binary content. */
  raw?: string
  /** URL the content is fetched from. */
  url?: string
  /** Structured JSON content. */
  data?: unknown
  /** File name the part represents. */
  filename?: string
  /** Media type of `raw` or `url` content. */
  mediaType?: string
  /** Peer-defined part metadata. */
  metadata?: Record<string, unknown>
}

/** One message exchanged between the caller and the agent. */
export interface A2AMessage {
  /** Message identity, stable for the message's lifetime. */
  messageId: string
  /** Conversation the message belongs to; absent on the first message. */
  contextId?: string
  /** Task the message belongs to, when it continues one. */
  taskId?: string
  /** Who wrote the message. */
  role: Role
  /** Message content. */
  parts: A2APart[]
  /** Peer-defined message metadata. */
  metadata?: Record<string, unknown>
  /** Extensions the message uses. */
  extensions?: string[]
  /** Tasks this message refers to. */
  referenceTaskIds?: string[]
}

/** One task's current status. */
export interface A2ATaskStatus {
  /** Lifecycle state. */
  state: TaskState
  /** Message describing the status, when the state carries one. */
  message?: A2AMessage
  /** ISO 8601 UTC timestamp with millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). */
  timestamp: string
}

/** One artifact a task produced. */
export interface A2AArtifact {
  /** Artifact identity, stable across the updates that grow it. */
  artifactId: string
  /** Human-readable artifact name. */
  name?: string
  /** Human-readable artifact description. */
  description?: string
  /** Artifact content. */
  parts: A2APart[]
  /** Peer-defined artifact metadata. */
  metadata?: Record<string, unknown>
}

/** One unit of work, with the history that produced it. */
export interface A2ATask {
  /** Task identity. */
  id: string
  /** Conversation the task belongs to; tshe unit callers continue. */
  contextId: string
  /** Current status. */
  status: A2ATaskStatus
  /** Artifacts the task produced so far. */
  artifacts: A2AArtifact[]
  /** Messages exchanged for this task, newest last. */
  history: A2AMessage[]
  /** Peer-defined task metadata. */
  metadata?: Record<string, unknown>
}

/** A status change inside a stream. */
export interface TaskStatusUpdateEvent {
  /** Task whose status changed. */
  taskId: string
  /** Conversation the task belongs to. */
  contextId: string
  /** Status after the change. */
  status: A2ATaskStatus
  /** Peer-defined metadata. */
  metadata?: Record<string, unknown>
}

/** An artifact create-or-grow event inside a stream. */
export interface TaskArtifactUpdateEvent {
  /** Task that produced the artifact. */
  taskId: string
  /** Conversation the task belongs to. */
  contextId: string
  /** Artifact content of this update. */
  artifact: A2AArtifact
  /** Whether the update appends to the artifact's earlier content. */
  append?: boolean
  /** Whether this update completes the artifact. */
  lastChunk?: boolean
  /** Peer-defined metadata. */
  metadata?: Record<string, unknown>
}

/**
 * One streamed response. The protocol's `StreamResponse` oneof has no
 * discriminant, so the present member names the event kind. A stream ends at
 * the task's terminal status; there is no terminator frame.
 */
export type A2AStreamEvent =
  | { task: A2ATask }
  | { message: A2AMessage }
  | { statusUpdate: TaskStatusUpdateEvent }
  | { artifactUpdate: TaskArtifactUpdateEvent }

/** One capability an agent advertises in its card. */
export interface AgentSkill {
  /** Skill identity, used as the message's `metadata.skill`. */
  id: string
  /** Human-readable skill name. */
  name: string
  /** What the skill does. */
  description: string
  /** Discovery tags. */
  tags: string[]
  /** Example requests. */
  examples?: string[]
  /** Input media types this skill accepts. */
  inputModes?: string[]
  /** Output media types this skill produces. */
  outputModes?: string[]
}

/** One endpoint an agent is reachable at, with the binding it speaks there. */
export interface AgentInterface {
  /** Endpoint URL. */
  url: string
  /** Binding spoken at `url`: `JSONRPC`, `GRPC`, or `HTTP+JSON`. */
  protocolBinding: string
  /** Tenant the endpoint serves, when it serves more than one. */
  tenant?: string
  /** A2A protocol version the endpoint speaks. */
  protocolVersion: string
}

/** An API-key security scheme. */
export interface APIKeySecurityScheme {
  /** What the key guards. */
  description?: string
  /** Where the key travels. */
  location: 'header' | 'query' | 'cookie'
  /** Header, query, or cookie name carrying the key. */
  name: string
}

/** One security scheme the card declares; unknown kinds pass through. */
export interface SecurityScheme {
  /** API-key scheme declaration. */
  apiKeySecurityScheme?: APIKeySecurityScheme
  /** Any other scheme the peer declares. */
  [key: string]: unknown
}

/** An agent's published card: how peers discover it. */
export interface AgentCard {
  /** Agent name. */
  name: string
  /** What the agent does. */
  description: string
  /** Every endpoint the agent is reachable at. */
  supportedInterfaces: AgentInterface[]
  /** Publishing organization. */
  provider?: { url: string; organization: string }
  /** Agent version. */
  version: string
  /** Documentation URL. */
  documentationUrl?: string
  /** Protocol features the agent implements. */
  capabilities: {
    /** Whether `SendStreamingMessage` is served. */
    streaming?: boolean
    /** Whether push-notification configuration is served. */
    pushNotifications?: boolean
    /** Whether `GetExtendedAgentCard` is served. */
    extendedAgentCard?: boolean
  }
  /** Security schemes referenced by `securityRequirements`. */
  securitySchemes?: Record<string, SecurityScheme>
  /** Schemes a caller must satisfy. */
  securityRequirements?: Array<{ schemes: Record<string, { list: string[] }> }>
  /** Input media types accepted when a skill names none. */
  defaultInputModes: string[]
  /** Output media types produced when a skill names none. */
  defaultOutputModes: string[]
  /** Capabilities the agent advertises. */
  skills: AgentSkill[]
  /** Agent icon URL. */
  iconUrl?: string
}

/**
 * Concatenate the text parts of a message or artifact.
 * @param parts - parts to read, absent when the message carried none.
 * @returns the joined text of the text parts, ignoring every other kind.
 */
export function textOf(parts: A2APart[] | undefined): string {
  if (parts === undefined) return ''
  return parts.map(part => part.text ?? '').join('')
}

/**
 * Whether a state ends the task, so no further event can follow.
 * @param state - the state to test.
 * @returns whether the state is terminal.
 */
export function isTerminal(state: TaskState): boolean {
  return state === 'TASK_STATE_COMPLETED'
    || state === 'TASK_STATE_FAILED'
    || state === 'TASK_STATE_CANCELED'
    || state === 'TASK_STATE_REJECTED'
}
