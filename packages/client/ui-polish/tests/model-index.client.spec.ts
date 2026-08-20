/** Model index definition: records messageId → model from assistant/message events. */
import { describe, expect, it } from 'vitest'
import { createModelIndex, modelIndexDefinition } from '../src/client/model-index.ts'

/** Minimal assistant/message event shape the definition reads. */
function assistantMessage(over: Record<string, unknown>): { type: string; data: Record<string, unknown>; seq: number } {
  return {
    type: 'assistant/message',
    seq: 1,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'm1',
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      },
      ...over,
    },
  }
}

describe('model index', () => {
  it('records the model of each settled assistant message by its message id', () => {
    const index = createModelIndex()
    const def = modelIndexDefinition(index)
    const event = assistantMessage({})
    const matched = def.match(event as never)
    expect(matched).toEqual({ id: 'm1', role: 'start' })
    def.start({} as never, { event } as never, {} as never)
    expect(index.modelOf('m1')).toBe('deepseek-v4-flash')
  })

  it('overwrites idempotently on replay (same message id, same or new model)', () => {
    const index = createModelIndex()
    const def = modelIndexDefinition(index)
    const first = assistantMessage({})
    const second = assistantMessage({ message: { id: 'm1', source: { kind: 'model', provider: 'p', model: 'deepseek-v4-pro' } } })
    def.start({} as never, { event: first } as never, {} as never)
    def.start({} as never, { event: second } as never, {} as never)
    expect(index.modelOf('m1')).toBe('deepseek-v4-pro')
  })

  it('ignores non-model events and messages without a model source', () => {
    const index = createModelIndex()
    const def = modelIndexDefinition(index)
    expect(def.match({ type: 'user/message', seq: 2 } as never)).toBeNull()
    const toolSource = assistantMessage({
      message: { id: 'm2', source: { kind: 'tool', callId: 'c1' } },
    })
    expect(def.match(toolSource as never)).toBeNull()
    expect(index.modelOf('m2')).toBeUndefined()
  })
})
