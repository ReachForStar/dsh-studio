import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmClassifyRequest,
  LlmClassifyResult,
  LlmGenerateImagesRequest,
  LlmGenerateImagesResult,
  LlmNonChatModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

class NonChatAdapter extends LlmAdapter {
  readonly classified: LlmClassifyRequest[] = []
  readonly imaged: LlmGenerateImagesRequest[] = []

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('not exercised')
  }

  override listNonChatModels(provider: string, type: 'classifier' | 'image'): Promise<readonly LlmNonChatModelInfo[]> {
    return Promise.resolve([{ provider, id: `${type}-1`, name: `Model ${type}` }])
  }

  override classify(request: LlmClassifyRequest): Promise<LlmClassifyResult> {
    this.classified.push(request)
    return Promise.resolve({ answers: { q: { type: 'bool', probability: 0.9 } }, stopReason: 'stop' })
  }

  override generateImages(request: LlmGenerateImagesRequest): Promise<LlmGenerateImagesResult> {
    this.imaged.push(request)
    return Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'stop' })
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new NonChatAdapter()
  ctx.llm.registerAdapter(['route'], adapter)
  return { ctx, adapter }
}

describe('llm non-chat delegation', () => {
  it('lists non-chat models through the addressed adapter', async () => {
    const { ctx } = await setup()
    expect(await ctx.llm.listNonChatModels('route', 'classifier')).toEqual([
      { provider: 'route', id: 'classifier-1', name: 'Model classifier' },
    ])
    await ctx.fiber.dispose()
  })

  it('delegates classify and image generation to the addressed adapter', async () => {
    const { ctx, adapter } = await setup()
    const answers = await ctx.llm.classify({
      provider: 'route',
      model: 'classifier-1',
      state: { text: 'hello' },
      questions: { q: { type: 'bool', instructions: 'is it hello?', criteria: { true: 'yes', false: 'no' } } },
    })
    expect(answers.stopReason).toBe('stop')
    expect(answers.answers).toHaveProperty('q')
    expect(adapter.classified).toHaveLength(1)
    const images = await ctx.llm.generateImages({
      provider: 'route',
      model: 'image-1',
      input: [{ type: 'text', text: 'a fox' }],
    })
    expect(images.output).toEqual([{ type: 'text', text: 'done' }])
    expect(adapter.imaged).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('rejects classify through an adapter that does not implement it', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['plain'], new class extends LlmAdapter {
      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw new Error('not exercised')
      }
    }())
    await expect(ctx.llm.classify({ provider: 'plain', model: 'm', state: {}, questions: {} }))
      .rejects.toThrow('UNSUPPORTED_OPTION')
    await ctx.fiber.dispose()
  })
})
