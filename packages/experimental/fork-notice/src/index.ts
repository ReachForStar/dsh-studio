/**
 * Restates a forked Session's ownership boundaries to its model.
 *
 * A fork inherits the source conversation's history, including promises the
 * source made about background work: subagents, background shells, schedules,
 * and follow-ups whose results go to the original Session. Without an explicit
 * notice the fork's model tends to wait for them, redo them, or report their
 * results as its own. The notice arrives as a sourced user message on the
 * fork's first step, so it is logged like any other user input and never
 * reaches unrelated Sessions.
 *
 * @module @deepseek-ai/dsh-fork-notice
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Loop-issued ownership notice on a forked Session's first step. */
    'fork-notice': { kind: 'fork-notice' }
  }
}

const NOTICE = [
  '<fork-notice>',
  'This conversation is a fork of another conversation, copied up to the previous message. The original conversation keeps going on its own and may be active right now, as may other forks of it.',
  '- Work started before the fork belongs to the original: background subagents, background shells, schedules, and follow-ups promised there. Their results and notifications go to the original, never here, and you cannot continue those subagents. Do not wait for them, redo them, or report their results as yours; if it matters, check what already happened (files, git, PRs, CI).',
  '- Files, repositories, branches, and external services are shared with the original. Before changing something the original was working on, check its current state, and put work that diverges from it on a new branch or worktree.',
  '- Otherwise work normally: new tasks need no extra checks, branches, or questions.',
  '- If it is unclear whether this fork or the original should do something, ask.',
  '</fork-notice>',
].join('\n')

/** Plugin name used by the Loader. */
export const name = 'fork-notice'

/**
 * Register the first-step notice for ordinary fork children.
 * @param ctx - plugin context that owns the listener.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const session = agent.session
    if (!session.header.isSeeded || session.header.origin === 'subagent' || announced(session)) return decision
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: NOTICE }],
        source: { kind: 'fork-notice' },
      })],
    }
  })
}

/**
 * Whether the child already logged its notice. Child-owned events only: an
 * inherited notice from an ancestor fork must not silence this fork's own.
 * @param session - the candidate fork child.
 * @returns `true` when a notice user message exists after the inherited prefix.
 */
function announced(session: Session): boolean {
  const start: number = session.firstLiveSeq
  const end: number = session.seq
  for (let seq = start; seq < end; seq += 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event?.type === 'user/message' && event.data.source.kind === 'fork-notice') return true
  }
  return false
}
