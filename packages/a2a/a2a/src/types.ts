/** One configured remote A2A agent. */
export interface A2APeerConfig {
  /** JSON-RPC endpoint, such as `https://agents.example/a2a/`. */
  url: string
  /** API key the peer's endpoint requires, sent as `X-Api-Key`. */
  apiKey?: string
  /** Path the peer publishes its card at, when not the well-known location. */
  cardPath?: string
  /** How long one call waits for the peer, in milliseconds. */
  timeoutMs?: number
}

/** Options one peer call may carry. */
export interface A2APeerCall {
  /** Continue a conversation the peer already keeps. */
  contextId?: string
  /** Continue the task itself, when the peer answered in task mode. */
  taskId?: string
  /** Cancellation owned by the caller. */
  signal?: AbortSignal
}

/** What one peer call answered with. */
export interface A2APeerReply {
  /** Text the peer produced, joined into one answer. */
  text: string
  /** Task the answer belongs to; pass it back to continue that task. */
  taskId?: string
  /** Conversation the peer keeps; pass it back to continue the exchange. */
  contextId?: string
  /** Task state name the peer ended in. */
  state?: string
}

/** One configured peer with the facts a surface shows about it. */
export interface A2APeerInfo {
  /** Configuration key naming the peer. */
  name: string
  /** Endpoint the peer was configured with. */
  url: string
  /** Peer display name, when its card was readable. */
  title?: string
  /** What the card reading failed with, when it failed. */
  error?: string
}

/** One peer the caller may address, by configured name or by URL. */
export type A2APeerRef = string
