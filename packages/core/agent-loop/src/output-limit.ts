/**
 * Output-limit continuation: when a reply reaches the model's output-token
 * ceiling, the turn appends one sourced user message asking the model to
 * resume from the cut point instead of ending with a truncated answer.
 * The message is admitted through the normal inbox path, so it is logged
 * like any other user message and survives reload.
 *
 * @module @deepseek-ai/dsh-agent-loop/output-limit
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Loop-issued continuation after a reply hit the output-token limit. */
    'output-limit': { kind: 'output-limit' }
  }
}

/** Loop-issued continuation text; fixed English, like other model-facing prompts. */
const CONTINUATION = [
  'Your previous message was cut off by the output-token limit.',
  'Continue from exactly where it stopped without repeating finished parts.',
  'If the remaining work is too large for one reply, split it into smaller steps.',
].join(' ')

/**
 * Build the continuation message for a truncated step.
 * @returns the user message to admit as the next step.
 */
export function outputLimitContinuation(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: CONTINUATION }],
    source: { kind: 'output-limit' },
  })
}
