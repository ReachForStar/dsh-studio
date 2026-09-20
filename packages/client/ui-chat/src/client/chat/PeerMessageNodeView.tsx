/** Peer-answer card: another agent's assistant message, attributed to its producer. */

import { memo, useMemo } from 'react'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import css from './PeerMessageNodeView.module.css'

/**
 * Project durable message content onto the assistant block vocabulary the
 * markdown renderer consumes. Text and reasoning carry their payload; anything
 * else keeps the raw block so an unmodelled part still renders as itself.
 * @param content - durable message content.
 * @returns blocks for the assistant markdown renderer.
 */
function toAssistantBlocks(content: readonly ContentBlock[]): readonly AssistantBlock[] {
  return content.map((block): AssistantBlock => {
    switch (block.type) {
      case 'text':
        return { kind: 'text', text: block.text }
      case 'reasoning':
        return { kind: 'reasoning', text: block.text }
      case 'image':
        return { kind: 'image', attachment: block.attachment }
      default:
        return { kind: 'other', block }
    }
  })
}

/** Keyed Chat renderer for one peer-agent answer. */
export const PeerMessageNodeView = memo(function PeerMessageNodeView({
  node, renderMessageImages, t,
}: ChatNodeViewProps<'peer-message'>) {
  const data = node.data
  const blocks = useMemo(() => toAssistantBlocks(data.content), [data.content])
  // The producer line names what the log actually recorded: the peer and the
  // skill. The role id stays on the node for callers that know the role table.
  const producer = data.producer.skill === ''
    ? data.producer.agent
    : `${data.producer.agent} · ${data.producer.skill}`
  return (
    <div className={css.root} data-peer-message={data.messageId} data-peer-role={data.producer.role}>
      <div className={css.header}>
        <span className={css.label}>{t('message.peerAnswer')}</span>
        {producer !== '' && <span className={css.producer} data-peer-producer>{producer}</span>}
      </div>
      <AssistantMarkdown
        blocks={blocks}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
      />
    </div>
  )
})
