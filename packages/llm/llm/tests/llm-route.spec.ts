/** Shared LLM routing: catalog flattening and candidate selection. */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { listLlmModels, llmRouteCandidates, llmRouteKey } from '@deepseek-ai/dsh-llm/route'

/** Minimal Host context carrying one llm service with a fixed catalog. */
function contextWith(catalog: Record<string, { id: string; name: string }[]>): Context {
  return {
    llm: {
      listProviders: () => Object.keys(catalog).map(id => ({ id })),
      listModels: async (provider: string) => catalog[provider] ?? [],
    },
  } as unknown as Context
}

describe('llmRouteKey', () => {
  it('joins provider and model', () => {
    expect(llmRouteKey({ provider: 'gateway', model: 'deepseek-flash' })).toBe('gateway/deepseek-flash')
  })
})

describe('listLlmModels', () => {
  it('flattens every provider catalog in provider order', async () => {
    const ctx = contextWith({
      gateway: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
      mirror: [{ id: 'deepseek-flash', name: 'Flash (mirror)' }, { id: 'qwen', name: 'Qwen' }],
    })
    expect(await listLlmModels(ctx)).toEqual([
      { provider: 'gateway', model: 'deepseek-flash', name: 'DeepSeek Flash' },
      { provider: 'mirror', model: 'deepseek-flash', name: 'Flash (mirror)' },
      { provider: 'mirror', model: 'qwen', name: 'Qwen' },
    ])
  })
})

describe('llmRouteCandidates', () => {
  const CATALOG = {
    gateway: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
    mirror: [{ id: 'deepseek-flash', name: 'Flash (mirror)' }, { id: 'qwen', name: 'Qwen' }],
  }

  it('returns every route in provider order when no hint is given', async () => {
    expect(await llmRouteCandidates(contextWith(CATALOG))).toEqual([
      { provider: 'gateway', model: 'deepseek-flash' },
      { provider: 'mirror', model: 'deepseek-flash' },
      { provider: 'mirror', model: 'qwen' },
    ])
  })

  it('selects the exact provider copy when the hint names provider and model', async () => {
    expect(await llmRouteCandidates(contextWith(CATALOG), 'mirror/deepseek-flash'))
      .toEqual([{ provider: 'mirror', model: 'deepseek-flash' }])
  })

  it('selects every provider offering a bare model id', async () => {
    expect(await llmRouteCandidates(contextWith(CATALOG), 'deepseek-flash'))
      .toEqual([{ provider: 'gateway', model: 'deepseek-flash' }, { provider: 'mirror', model: 'deepseek-flash' }])
  })

  it('selects by display name', async () => {
    expect(await llmRouteCandidates(contextWith(CATALOG), 'Qwen'))
      .toEqual([{ provider: 'mirror', model: 'qwen' }])
  })

  it('rejects a hint that matches nothing', async () => {
    await expect(llmRouteCandidates(contextWith(CATALOG), 'nope')).rejects.toThrow(/model "nope" is not available/)
  })

  it('rejects an empty provider list', async () => {
    await expect(llmRouteCandidates(contextWith({}))).rejects.toThrow(/no LLM provider/)
  })

  it('rejects a provider list without models', async () => {
    await expect(llmRouteCandidates(contextWith({ gateway: [] }))).rejects.toThrow(/no LLM model/)
  })
})
