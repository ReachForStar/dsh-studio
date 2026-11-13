/** Delivery into a Session that is already live. */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WebhookRuleId } from './brand.ts'
import type { VerifiedWebhookDelivery, WebhookMessageRequest } from './types.ts'

/** Detached values delivery keeps across the liveness lookup. */
interface ResolvedWebhookMessageRequest {
  readonly sessionId: string
  readonly prompt: string
  readonly target: 'next-turn' | 'next-step'
}

/** Require one non-empty string field from an untyped rule result. */
function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`webhook message request ${field} must be a non-empty string`)
  }
  return value
}

/** Snapshot and validate a same-process message request before any await. */
function resolveMessageRequest(input: WebhookMessageRequest): ResolvedWebhookMessageRequest {
  const candidate: unknown = input
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('webhook rule result must be null, a Session request, or a message request')
  }
  const record = candidate as Record<string, unknown>
  const target = record['target']
  if (target !== 'next-turn' && target !== 'next-step') {
    throw new TypeError(`webhook message request target must be "next-turn" or "next-step", got ${JSON.stringify(target)}`)
  }
  return {
    sessionId: requiredString(record, 'sessionId'),
    prompt: requiredString(record, 'prompt'),
    target,
  }
}

/**
 * Append one verified delivery to an active Session's inbox.
 *
 * Delivery never creates or resumes a Session: a target without a live Agent
 * fails loudly so the rule can fall back to a Session request of its own.
 * @param ctx - untraced runtime context exposing the Agent registry.
 * @param delivery - exact verified provider delivery recorded in the message source.
 * @param ruleId - rule that returned the request.
 * @param request - same-process rule result.
 * @param signal - registration lifetime cancellation through admission.
 * @throws when the request is malformed or the target Session has no live Agent.
 */
export function deliverWebhookMessage(
  ctx: Context,
  delivery: VerifiedWebhookDelivery,
  ruleId: WebhookRuleId,
  request: WebhookMessageRequest,
  signal: AbortSignal,
): void {
  const resolved = resolveMessageRequest(request)
  signal.throwIfAborted()
  const agent = ctx.agents.get(brandString<SessionId>(resolved.sessionId))
  if (agent === undefined) {
    throw new Error(`webhook: Session "${resolved.sessionId}" has no live Agent to receive the delivery`)
  }
  const message = createUserMessage({
    content: [{ type: 'text', text: resolved.prompt }],
    source: {
      kind: 'webhook',
      provider: delivery.kind,
      source: delivery.source,
      deliveryId: delivery.deliveryId,
      ruleId,
      form: 'notice',
      summary: boundContextSummary(`${delivery.kind} webhook delivered by ${ruleId}`),
    },
  })
  if (resolved.target === 'next-step') agent.steer(message)
  else agent.followup(message)
}
