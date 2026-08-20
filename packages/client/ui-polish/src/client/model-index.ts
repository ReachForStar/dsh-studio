// Model index: a lightweight Conversation Definition that records the model
// id of each settled assistant message (messageId → model). The core client
// nodes carry `usage` but not the model provenance (upstream gap), so this
// plugin keeps its own index from the same `assistant/message` events and
// bills each step's usage at its own model's rate.

import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
  ConversationMatchResult,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Minimal state machine: nothing to fold, the event is the whole fact. */
type EmptyState = Record<string, never>

/** Extract the message id and model from a settled assistant/message event. */
/* oxlint-disable typescript/no-unnecessary-condition -- the match face may hand any session event */
function assistantMessageFacts(event: ConversationMatch['event']): { messageId: string; model: string } | null {
  if (event.type !== 'assistant/message') return null
  const source = event.data.message.source
  if (source.kind !== 'model') return null
  const model = source.model
  if (model.length === 0) return null
  const messageId = String(event.data.message.id)
  if (messageId.length === 0) return null
  return { messageId, model }
}
/* oxlint-enable typescript/no-unnecessary-condition */

/**
 * Apply-owned model index: a plain messageId → model map plus the write and
 * read faces. Message ids are globally unique, and the Definition runs across
 * every session, so one map serves the whole app; the stats float looks up by
 * the message id its node carries. No reactivity is needed — the component's
 * node subscription already drives re-renders, and a settled message's model
 * never changes.
 */
export interface ModelIndex {
  /** Record one settled assistant message's model (idempotent by messageId). */
  readonly record: (messageId: string, model: string) => void
  /** Resolve one message id's model; undefined when not yet recorded. */
  readonly modelOf: (messageId: string) => string | undefined
}

/** Create the apply-owned model index (one per plugin instance, never module-level).
 * @returns the messageId → model index handle.
 */
export function createModelIndex(): ModelIndex {
  const modelByMessageId = new Map<string, string>()
  return {
    record: (messageId, model) => { modelByMessageId.set(messageId, model) },
    modelOf: messageId => modelByMessageId.get(messageId),
  }
}

/**
 * One-session Definition recording the model of every settled assistant
 * message. State-only: it publishes no view node; the record side effect feeds
 * the stats float's per-model billing. Replays are idempotent — `record`
 * overwrites by messageId, and message ids are globally unique.
 * @param index - the apply-owned model index to write.
 * @returns the Definition contribution.
 */
export function modelIndexDefinition(index: ModelIndex): ConversationNodeDefinition<EmptyState> {
  return {
    kind: 'ui-polish-model-index',
    match: (event): ConversationMatchResult | null => {
      const facts = assistantMessageFacts(event)
      return facts === null
        ? null
        : { id: facts.messageId, role: 'start' }
    },
    start: (_context: ConversationNodeContext<EmptyState>, match): EmptyState => {
      const facts = assistantMessageFacts(match.event)
      if (facts !== null) index.record(facts.messageId, facts.model)
      return {}
    },
    update: context => context.state,
  }
}
