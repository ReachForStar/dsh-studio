/**
 * Provider and model routing shared by this package's LLM features: commit
 * messages in the Git panel and writing assistance in the LaTeX panel. A client
 * that picked a model gets exactly that route; a default request gets every
 * provider's models in order, because a provider can be registered with a model
 * catalog while its credentials are missing — such a provider fails on the
 * first attempt, and the caller can move on to the next candidate.
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

/** One provider/model pair a request can stream with. */
export interface LlmRoute {
  readonly provider: string
  readonly model: string
}

/**
 * Client-facing key of one route. Two providers can offer the same model id
 * (an official gateway and a mirror both exposing `deepseek-flash`), so a
 * picker that stored the bare id would select the wrong provider's copy.
 * @param route - the provider/model pair.
 * @returns the `provider/model` key.
 */
export function llmRouteKey(route: LlmRoute): string {
  return `${route.provider}/${route.model}`
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
 * Candidate routes in attempt order.
 * @param ctx - Host context providing the llm service.
 * @param hint - optional model id or display name from the client.
 * @returns the hinted route alone, or every provider's models in provider order.
 * @throws {Error} when no provider exists, no model is offered, or the hint matches nothing.
 */
export async function llmRouteCandidates(ctx: Context, hint?: string): Promise<readonly LlmRoute[]> {
  const providers = ctx.llm.listProviders()
  if (providers.length === 0) throw new Error('ui-polish: no LLM provider is available')
  const entries: { route: LlmRoute; name: string }[] = []
  for (const provider of providers) {
    for (const model of await ctx.llm.listModels(provider.id)) {
      entries.push({ route: { provider: provider.id, model: model.id }, name: model.name })
    }
  }
  if (hint !== undefined) {
    // A hint naming a provider and model selects that provider's copy; a bare
    // model id or display name keeps the older behavior and takes the first
    // provider that offers it.
    const exact = entries.filter(entry => hint === llmRouteKey(entry.route))
    const named = exact.length > 0
      ? exact
      : entries.filter(entry => entry.route.model === hint || entry.name === hint)
    if (named.length === 0) throw new Error(`ui-polish: model "${hint}" is not available on any provider`)
    return named.map(entry => entry.route)
  }
  if (entries.length === 0) throw new Error('ui-polish: no LLM model is available')
  return entries.map(entry => entry.route)
}
