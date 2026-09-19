/**
 * LLM commit-message generation for the git panel. The host streams one
 * generation through `ctx.llm.stream` with the rule-rendered system prompt and
 * user context, forwarding text deltas as they arrive. The model is resolved
 * from the LLM service: an optional client hint (model id) is matched against
 * the advisory catalogs, falling back to the first available provider's first
 * model, so the route works without the client knowing the provider topology.
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the llm Context merge (ctx.llm).
import type {} from '@deepseek-ai/dsh-llm'
import type { CommitMessageBridge, GitModel } from './git-service.ts'
import { listLlmModels, resolveLlmRoute } from './llm-route.ts'

/**
 * Build the commit-message bridge bound to a Host context.
 * @param ctx - the Host context providing the llm service.
 * @returns the bridge passed to the git service's `/git/generate` and `/git/models` routes.
 */
export function createCommitMessageBridge(ctx: Context): CommitMessageBridge {
  return {
    async stream(params) {
      const route = await resolveLlmRoute(ctx, params.model)
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system: params.system,
        messages: [createUserMessage({
          content: [{ type: 'text', text: params.user }],
          source: { kind: 'plugin', plugin: 'dsh-client-ui-polish' },
        })],
        temperature: 0,
        signal: params.signal,
      })
      const assembler = new BlockAssembler()
      let finished = false
      for await (const chunk of stream) {
        if (finished) throw new Error('ui-polish git: reviewer stream emitted data after its terminal finish')
        assembler.push(chunk)
        if (chunk.type === 'text-delta') params.onText(chunk.text)
        if (chunk.type === 'finish') {
          finished = true
          if (!params.signal.aborted && chunk.reason.kind !== 'stop') {
            throw new Error(`ui-polish git: commit-message generation ended with ${chunk.reason.kind}`)
          }
        }
      }
      if (!finished && !params.signal.aborted) {
        throw new Error('ui-polish git: commit-message generation emitted no terminal finish')
      }
      const blocks = assembler.blocks()
      const textBlocks = blocks.filter(block => block.type === 'text')
      const text = textBlocks.map(block => (block as { text: string }).text).join('').trim()
      if (text.length === 0) throw new Error('ui-polish git: generation returned an empty message')
      return text
    },
    async listModels(): Promise<readonly GitModel[]> {
      return [...await listLlmModels(ctx)]
    },
  }
}
