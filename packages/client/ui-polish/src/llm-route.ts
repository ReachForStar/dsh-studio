/**
 * Provider and model routing shared by this package's LLM features: commit
 * messages in the Git panel and writing assistance in the LaTeX panel. Both
 * resolve the same way — an explicit client hint matched against every
 * provider's advisory catalog, otherwise the first provider that offers a
 * model — so a client picker can name a working route when the default
 * provider has no usable credentials.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the llm Context merge (ctx.llm).
import type {} from '@deepseek-ai/dsh-llm'

/** One selectable provider/model pair. */
export interface LlmModelOption {
  readonly provider: string
  readonly model: string
  readonly name: string
}

/**
 * Every provider's advisory model catalog, flattened for a client picker.
 * @param ctx - Host context providing the llm service.
 * @returns the options in provider order.
 */
export async function listLlmModels(ctx: Context): Promise<readonly LlmModelOption[]> {
  const options: LlmModelOption[] = []
  for (const provider of ctx.llm.listProviders()) {
    for (const model of await ctx.llm.listModels(provider.id)) {
      options.push({ provider: provider.id, model: model.id, name: model.name })
    }
  }
  return options
}

/**
 * Resolve the provider/model pair one request streams with.
 * @param ctx - Host context providing the llm service.
 * @param hint - optional model id or display name from the client.
 * @returns the resolved provider and model.
 * @throws {Error} when no provider exists or the hint matches nothing.
 */
export async function resolveLlmRoute(
  ctx: Context,
  hint?: string,
): Promise<{ provider: string; model: string }> {
  const providers = ctx.llm.listProviders()
  if (providers.length === 0) throw new Error('ui-polish: no LLM provider is available')
  if (hint !== undefined) {
    for (const provider of providers) {
      const models = await ctx.llm.listModels(provider.id)
      const match = models.find(model => model.id === hint || model.name === hint)
      if (match !== undefined) return { provider: provider.id, model: match.id }
    }
    throw new Error(`ui-polish: model "${hint}" is not available on any provider`)
  }
  for (const provider of providers) {
    const [first] = await ctx.llm.listModels(provider.id)
    if (first !== undefined) return { provider: provider.id, model: first.id }
  }
  throw new Error('ui-polish: no LLM model is available')
}
