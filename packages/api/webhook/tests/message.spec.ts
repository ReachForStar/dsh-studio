import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  WebhookDeliveryId,
  WebhookRuleId,
  WebhookSourceId,
  type VerifiedWebhookDelivery,
  type WebhookMessageRequest,
} from '../src/index.ts'
import { deliverWebhookMessage } from '../src/message.ts'

/** One valid generic delivery. */
function delivery(): VerifiedWebhookDelivery<'fixture'> {
  return {
    kind: 'fixture',
    source: WebhookSourceId('fixture-source'),
    deliveryId: WebhookDeliveryId('delivery-1'),
    event: { value: 1 },
    receivedAt: 1,
  }
}

const RULE = WebhookRuleId('fixture-rule')

/** Live-Session fake recording each inbox append. */
function harness(options: { live?: boolean } = {}) {
  const received: { source: unknown; text: string }[] = []
  const calls: string[] = []
  const agent = {
    followup(message: { content: readonly { type: string; text?: string }[]; source: unknown }) {
      calls.push('followup')
      received.push({ source: message.source, text: message.content[0]?.text ?? '' })
    },
    steer(message: { content: readonly { type: string; text?: string }[]; source: unknown }) {
      calls.push('steer')
      received.push({ source: message.source, text: message.content[0]?.text ?? '' })
    },
  }
  const ctx = {
    agents: { get: () => options.live === false ? undefined : agent },
  } as unknown as Context
  return { ctx, received, calls }
}

function request(overrides: Partial<WebhookMessageRequest> = {}): WebhookMessageRequest {
  return { kind: 'message', sessionId: 'session-1', prompt: 'deploy finished', target: 'next-turn', ...overrides }
}

describe('deliverWebhookMessage', () => {
  it('appends a follow-up turn carrying the webhook source', () => {
    const { ctx, received, calls } = harness()
    deliverWebhookMessage(ctx, delivery(), RULE, request(), new AbortController().signal)
    expect(calls).toEqual(['followup'])
    expect(received[0]?.text).toBe('deploy finished')
    expect(received[0]?.source).toMatchObject({
      kind: 'webhook',
      provider: 'fixture',
      source: 'fixture-source',
      deliveryId: 'delivery-1',
      ruleId: 'fixture-rule',
      form: 'notice',
    })
  })

  it('steers the running turn when the request asks for the next step', () => {
    const { ctx, calls } = harness()
    deliverWebhookMessage(
      ctx, delivery(), RULE, request({ target: 'next-step' }), new AbortController().signal,
    )
    expect(calls).toEqual(['steer'])
  })

  it('fails loudly when the target Session has no live Agent', () => {
    const { ctx } = harness({ live: false })
    expect(() => {
      deliverWebhookMessage(ctx, delivery(), RULE, request(), new AbortController().signal)
    }).toThrow('has no live Agent')
  })

  it('rejects a malformed request before touching the registry', () => {
    const { ctx } = harness()
    const signal = new AbortController().signal
    expect(() => {
      deliverWebhookMessage(ctx, delivery(), RULE, request({ sessionId: ' ' }), signal)
    }).toThrow('sessionId must be a non-empty string')
    expect(() => {
      deliverWebhookMessage(ctx, delivery(), RULE, request({ prompt: '' }), signal)
    }).toThrow('prompt must be a non-empty string')
    expect(() => {
      deliverWebhookMessage(
        ctx, delivery(), RULE, { ...request(), target: 'later' } as unknown as WebhookMessageRequest, signal,
      )
    }).toThrow('target must be')
    expect(() => {
      deliverWebhookMessage(ctx, delivery(), RULE, [] as unknown as WebhookMessageRequest, signal)
    }).toThrow('must be null, a Session request, or a message request')
  })

  it('stops before delivery once the registration is disposed', () => {
    const { ctx, calls } = harness()
    const controller = new AbortController()
    controller.abort(new Error('disposed'))
    expect(() => {
      deliverWebhookMessage(ctx, delivery(), RULE, request(), controller.signal)
    }).toThrow('disposed')
    expect(calls).toEqual([])
  })
})
