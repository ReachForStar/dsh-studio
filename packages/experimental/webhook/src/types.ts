/** Provider-neutral webhook deliveries, rules, and Session requests. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { WebhookDeliveryId, WebhookRuleId, WebhookSourceId } from './brand.ts'

/** Provider adapters add their normalized event type through declaration merging. */
export interface WebhookEventMap {}

/** Event value for a known provider kind, or generic lossless JSON for an out-of-tree kind. */
export type WebhookEventOf<K extends string> =
  K extends keyof WebhookEventMap ? WebhookEventMap[K] : JsonValue

/** One authenticated and parsed provider delivery. */
export interface VerifiedWebhookDelivery<K extends string = string> {
  /** Provider family such as `github`. */
  readonly kind: K
  /** Configured adapter instance such as `primary-github`. */
  readonly source: WebhookSourceId
  /** Provider delivery identifier exposed in message sources, never as built-in deduplication state. */
  readonly deliveryId: WebhookDeliveryId
  /** Provider-normalized lossless JSON. */
  readonly event: WebhookEventOf<K>
  /** Host receipt time in Unix epoch milliseconds. */
  readonly receivedAt: number
}

/** Optional explicit model route and output cap for a webhook-created Agent. */
export interface WebhookModelSelection {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Optional positive output-token cap. */
  readonly maxTokens?: number
}

/** Create and prompt one root Session. */
export interface WebhookSessionRequest {
  /** Action discriminant; omitted means the same thing as `session`. */
  readonly kind?: 'session'
  /** Existing local directory to resolve or create as a Web Workspace. */
  readonly workspacePath: string
  /** Explicit Session title. */
  readonly title: string
  /** Non-empty initial text prompt. */
  readonly prompt: string
  /** Agent composition mounted before publication. */
  readonly agentPreset: string
  /** Sandbox and approval preset applied before prompt admission. */
  readonly permissionPreset: string
  /** Optional explicit route; omission uses the complete current default, including reasoning effort. */
  readonly model?: WebhookModelSelection
}

/**
 * Deliver one message into a Session that is already live.
 *
 * Delivery is fire-and-forget like Session creation: the runtime appends the
 * message to the target's inbox and never waits for a turn. Repeated delivery
 * of the same provider event appends again; a rule that must deduplicate owns
 * that state, because the runtime keeps none.
 */
export interface WebhookMessageRequest {
  /** Action discriminant. */
  readonly kind: 'message'
  /** Target Session id; it must have a live Agent, otherwise delivery fails. */
  readonly sessionId: string
  /** Non-empty text delivered as model-visible input. */
  readonly prompt: string
  /**
   * Inbox boundary. `next-turn` queues an ordinary follow-up turn; `next-step`
   * steers the turn already running and is ignored while the Session is idle
   * beyond the ordinary steering contract.
   */
  readonly target: 'next-turn' | 'next-step'
}

/** One action a rule may request for a delivery. */
export type WebhookAction = WebhookSessionRequest | WebhookMessageRequest

/** Trusted code that optionally requests one action for a delivery. */
export interface WebhookRule<K extends string = string> {
  /** Globally unique diagnostic identity. */
  readonly id: WebhookRuleId
  /** Provider kind this rule receives. */
  readonly kind: K
  /**
   * Run arbitrary trusted code and optionally request one action.
   * @param delivery - immutable authenticated provider data.
   * @param signal - aborts when this registration or the runtime unloads.
   * @returns one action request, or `null` for no action.
   */
  run(
    delivery: Readonly<VerifiedWebhookDelivery<K>>,
    signal: AbortSignal,
  ): WebhookAction | null | Promise<WebhookAction | null>
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Programmatic input admitted from one verified webhook rule. */
    webhook: {
      readonly kind: 'webhook'
      readonly provider: string
      readonly source: WebhookSourceId
      readonly deliveryId: WebhookDeliveryId
      readonly ruleId: WebhookRuleId
      readonly form: 'notice'
      readonly summary: string
    }
  }
}
