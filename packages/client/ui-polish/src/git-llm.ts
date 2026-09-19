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
import { listLlmModels, llmRouteCandidates, type LlmRoute } from './llm-route.ts'

/**
 * Build the commit-message bridge bound to a Host context.
 * @param ctx - the Host context providing the llm service.
 * @returns the bridge passed to the git service's `/git/generate` and `/git/models` routes.
 */
export function createCommitMessageBridge(ctx: Context): CommitMessageBridge {
  return {
    async stream(params) {
      const candidates = await llmRouteCandidates(ctx, params.model)
      const failures: string[] = []
      for (const route of candidates) {
        // Held in an object so the delta callback's write is visible here:
        // TypeScript narrows a local `let` to its initializer across the await.
        const state = { emitted: false }
        try {
          return await streamRoute(ctx, route, params, () => { state.emitted = true })
        } catch (error) {
          // Deltas already sent cannot be withdrawn, so another route would print
          // the message twice; an aborted request ends the walk as well.
          if (state.emitted || params.signal.aborted) throw error
          failures.push(`${route.provider}/${route.model}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      throw new Error(`ui-polish git: no model produced a message — ${failures.join('; ')}`)
    },
    async listModels(): Promise<readonly GitModel[]> {
      return [...await listLlmModels(ctx)]
    },
  }
}

/**
 * Stream one generation through one resolved route.
 * @param ctx - the Host context providing the llm service.
 * @param route - provider/model pair to stream with.
 * @param params - the bridge request: prompts, abort signal, and delta sink.
 * @param onEmit - called before the first delta reaches the client.
 * @returns the assembled message text.
 * @throws {Error} when the stream fails to finish or returns no text.
 */
async function streamRoute(
  ctx: Context,
  route: LlmRoute,
  params: Parameters<CommitMessageBridge['stream']>[0],
  onEmit: () => void,
): Promise<string> {
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
    if (chunk.type === 'text-delta') {
      onEmit()
      params.onText(chunk.text)
    }
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
}
