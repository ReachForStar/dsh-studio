/** Peer-agent answers: an assistant message another agent produced for this Session. */

import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { chatNode } from './common.ts'

/** Attribution of the agent that produced one peer answer. */
export interface PeerMessageProducer {
  /** Peer name the dispatch reached, or the local seat's provider id. */
  readonly agent: string
  /** Skill the task ran under on the peer. */
  readonly skill: string
  /** Star-domain role id, when the producer is a specialist seat. */
  readonly role: string
}

/** One peer-agent answer rendered in this Session's transcript. */
export interface PeerMessageNode {
  /** Kind discriminator for the keyed Chat renderer seat. */
  kind: 'peer-message'
  seq: number
  time: number
  /** Stable identity of the durable message. */
  messageId: string
  producer: PeerMessageProducer
  content: readonly ContentBlock[]
}

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** An assistant answer another agent produced outside this Session's loop. */
    'peer-message': PeerMessageNode
  }
}

/** Read one attribution field from a merge-extensible source payload. */
function producerField(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Peer-message Definition: a turn-free assistant answer. The event carries no
 * turn or step, so the node anchors on its own seq and the transcript renders it
 * outside the Turn grouping that ordinary assistant steps join.
 */
export const peerMessageDefinition: ConversationNodeDefinition<PeerMessageNode> = {
  kind: 'peer-message',
  target: 'chat',
  match: event => event.type === 'assistant/peer-message' && isAppendSurfaceEvent(event)
    ? { id: String(event.data.message.id), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'assistant/peer-message') {
      throw new Error('peer-message start requires assistant/peer-message')
    }
    const event = match.event
    const source = event.data.message.source as unknown as Record<string, unknown>
    return {
      kind: 'peer-message',
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.message.id),
      producer: {
        agent: producerField(source, 'agent'),
        skill: producerField(source, 'skill'),
        role: producerField(source, 'role'),
      },
      content: event.data.message.content,
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNode(context, 'peer-message', context.state.seq, context.state)
  },
}

/**
 * Register the peer-answer contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerPeerMessageConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(peerMessageDefinition)
}
