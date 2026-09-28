import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { migrateV4Content, migrateV4EventContent } from '../src/content.ts'
import { createSessionFormatV4ToV5, releasedV5SessionFormatCodec } from '../src/index.ts'
import { assertV5MessageSources } from '../src/message-sources.ts'
import { namespaceV4OpaqueEvent } from '../src/extension-identities.ts'

const image = { type: 'image', attachment: { attachmentId: 'image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
const wrapper = { type: 'future', content: [{ type: 'tool-result', toolCallId: 'opaque', content: [image] }] }
const convertedBlock = { ...wrapper, type: 'plugin:future' }
const user = { id: 'user', role: 'user', source: { kind: 'user' }, content: [wrapper] }
const event = (type: string, data: SessionFormatJsonValue): SessionFormatEvent => ({ type, seq: 0, time: 1, data })

function migrate(row: SessionFormatEvent): SessionFormatEvent {
  const sourceHeader = { version: 4, id: 'content', createdAt: 0, isSeeded: false, delegationDepth: 0 }
  const stage = createSessionFormatV4ToV5([]).createStage({ sourceHeader, targetHeader: { ...sourceHeader, version: 5 }, sourceInheritedEventCount: 0, sourceKind: 'decoded' })
  const collector = new SessionFormatEventCollector()
  stage.transformEvent(row, collector)
  stage.finish(collector)
  return collector.values[0]!
}

describe('V4 content conversion', () => {
  it('preserves own extension keys without changing opaque values or source content', () => {
    const old = JSON.parse('{"type":"vendor","metadata":{"tag":"old"},"__proto__":{"saved":true},"constructor":{"saved":false}}') as SessionFormatJsonObject
    const actual = migrateV4Content([old, image], 'sample')
    expect(actual).toEqual([{ ...old, type: 'plugin:vendor' }, image])
    const data = actual[0] as SessionFormatJsonObject
    expect(Object.hasOwn(data, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype)
    expect(actual[1]).toBe(image)
    expect(old['type']).toBe('vendor')
  })

  it.each(['message', 'extension', '', 'future', 'plugin:future'])('keeps the unknown V4 tag %j opaque', (type) => {
    const block = { type, content: [wrapper], message: { role: 'tool', content: [wrapper] }, data: wrapper }
    expect(migrateV4Content([block], 'sample')).toEqual([{ ...block, type: `plugin:${type}` }])
  })

  it.each(['tool-addition', 'tool-removal'])('shares the developer tool-change block %j with V5', (type) => {
    const content = [{ type, toolName: 'search' }]
    expect(migrateV4Content(content, 'sample')).toBe(content)
  })

  it('shares unchanged leaves and ignores JSON that is not a declared content slot', () => {
    const content = [{ type: 'text', text: 'saved', metadata: wrapper }, { type: 'tool-call', id: 'call', name: 'echo', arguments: JSON.stringify(wrapper) }, image]
    expect(migrateV4Content(content, 'sample')).toBe(content)
    const row = event('user/message', { ...user, content, replayState: wrapper, schema: { examples: [wrapper] } })
    expect(migrateV4EventContent(row)).toBe(row)
    const opaque = event('future', { content: [wrapper] })
    expect(migrateV4EventContent(opaque)).toBe(opaque)
    const scalar = event('future', null)
    expect(migrateV4EventContent(scalar)).toBe(scalar)
  })

  it.each([
    ['user/message', user, { ...user, content: [convertedBlock] }],
    ['system/message', { message: user }, { message: { ...user, content: [convertedBlock] } }],
    ['assistant/message', { message: user }, { message: { ...user, content: [convertedBlock] } }],
    ['agent/inbox/spliced', { inserted: [user] }, { inserted: [{ ...user, content: [convertedBlock] }] }],
    ['session/title-llm-request', { messages: [user] }, { messages: [{ ...user, content: [convertedBlock] }] }],
    ['compaction/summary', { summary: [wrapper], rawOutput: [wrapper] }, { summary: [convertedBlock], rawOutput: [convertedBlock] }],
    ['compaction/summary', { summary: [] }, { summary: [] }],
    ['tool/ptc-dispatch', { content: [wrapper] }, { content: [convertedBlock] }],
    ['team/message/queued', { message: user }, { message: { ...user, content: [convertedBlock] } }],
    ['team/message/queued', { message: { ...user, content: [] } }, { message: { ...user, content: [] } }],
    ['team/message/queued', { message: null }, { message: null }],
  ] as const)('converts declared %s content without changing envelope coordinates', (type, data, expected) => {
    const row = {
      ...event(type, data), seq: 3, sourceEventSeqs: [0, 2], surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2 }, extra: { content: [wrapper] },
    } as SessionFormatEvent
    const before = structuredClone(row)
    expect(migrateV4EventContent(row)).toEqual({ ...row, data: expected })
    expect(row).toEqual(before)
  })

  it.each(['assistant/message', 'assistant/attempt'])('converts raw %s start/end blocks and preserves start-owned fields', (type) => {
    const chunk = (value: SessionFormatJsonValue): SessionFormatJsonObject => ({ type: 'chunk', chunk: value, time: 7 })
    const stream = [
      chunk({ type: 'block-start', index: 0, blockType: 'future', extensionName: 'old', metadata: { old: true }, custom: wrapper }),
      chunk({ type: 'block-end', index: 0, block: wrapper }),
      chunk({ type: 'block-start', index: 1, blockType: 'message' }),
      chunk({ type: 'block-end', index: 1, block: { type: 'message', content: [wrapper] } }),
      chunk({ type: 'block-start', index: 2, blockType: 'text' }),
      chunk({ type: 'block-start', index: 3, blockType: 'text', metadata: { original: true } }),
      chunk({ type: 'block-end', index: 2, block: { type: 'text', text: 'after' } }),
      chunk({ type: 'text-delta', index: 2, text: 'after' }),
      chunk(null), null, { type: 'annotation', data: wrapper },
    ]
    const actual = migrateV4EventContent(event(type, { message: { ...user, content: [] }, stream }))
    expect(actual.data).toEqual({ message: { ...user, content: [] }, stream: [
      chunk({ type: 'block-start', index: 0, blockType: 'plugin:future', extensionName: 'old', metadata: { old: true }, custom: wrapper }),
      chunk({ type: 'block-end', index: 0, block: convertedBlock }),
      chunk({ type: 'block-start', index: 1, blockType: 'plugin:message' }),
      chunk({ type: 'block-end', index: 1, block: { type: 'plugin:message', content: [wrapper] } }),
      stream[4], stream[5],
      ...stream.slice(6),
    ] })
    const unchanged = event(type, { message: { ...user, content: [] }, stream: stream.slice(6) })
    expect(migrateV4EventContent(unchanged)).toBe(unchanged)
  })

  it('preserves V4 request-tool metadata keys and values', () => {
    const parameters = { type: 'object', properties: {}, examples: [wrapper], deferLoading: true }
    const extras = JSON.parse('{"vendor":{"saved":true},"plugin:vendor":{"saved":false},"plugin:deferLoading":false,"__proto__":{"saved":"prototype"},"constructor":{"saved":"constructor"}}') as SessionFormatJsonObject
    const tool = { name: 'echo', description: 'Echo', parameters, ...extras }
    const row = event('request/header', { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' }, tools: [tool] } })
    const before = structuredClone(row)
    const converted = migrate(row)
    expect(converted).toBe(row)
    expect(converted).toEqual(before)
    expect(() => releasedV5SessionFormatCodec.encodeEvent(converted)).not.toThrow()
    expect(Object.hasOwn(tool, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(tool)).toBe(Object.prototype)
    expect(tool.parameters.deferLoading).toBe(true)
    expect(tool).toHaveProperty('plugin:deferLoading', false)
  })

  it('carries a declared V4 deferLoading request tool into V5 unchanged', () => {
    const tool = { name: 'echo', description: 'Echo', parameters: {}, deferLoading: true }
    const row = event('request/header', { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' }, tools: [tool] } })
    expect(migrate(row)).toBe(row)
  })

  it.each([false, null, 'custom'])('leaves a malformed V4 deferLoading value %j to native V5 admission', (deferLoading) => {
    const tool = { name: 'echo', description: 'Echo', parameters: {}, deferLoading }
    const row = event('request/header', { reason: 'initial', header: {
      config: { provider: 'mock', model: 'mock' },
      tools: [{ name: 'first', description: 'First', parameters: {} }, tool],
    } })
    const before = structuredClone(row)
    expect(migrate(row)).toBe(row)
    expect(row).toEqual(before)
    expect(() => releasedV5SessionFormatCodec.encodeEvent(row)).toThrow(/deferLoading must be true/)
  })

  it('preserves stream-start extra keys while converting its unknown block type', () => {
    const extra = JSON.parse('{"deferLoading":true,"plugin:deferLoading":false,"metadata":{"saved":1},"plugin:metadata":{"saved":2},"__proto__":{"saved":3}}') as SessionFormatJsonObject
    const start = { type: 'block-start', index: 7, blockType: 'plugin:text', ...extra }
    const stream = migrateV4EventContent(event('assistant/attempt', { stream: [{ type: 'chunk', chunk: start }] }))
    expect(stream.data).toEqual({ stream: [{ type: 'chunk', chunk: { ...start, blockType: 'plugin:plugin:text' } }] })
    expect(extra['deferLoading']).toBe(true)
    expect(Object.hasOwn(extra, '__proto__')).toBe(true)
  })

  it('retains native V5 deferred-loading declaration validation', () => {
    const tool = { name: 'echo', description: 'Echo', parameters: {}, deferLoading: true }
    const header = { config: { provider: 'mock', model: 'mock' }, tools: [tool] }
    const row = event('request/header', { header })
    const physical = releasedV5SessionFormatCodec.encodeEvent(row)
    const collector = new SessionFormatEventCollector()
    releasedV5SessionFormatCodec.createDecoder({ type: 'session', version: 5, id: 'native', createdAt: 0, isSeeded: false, delegationDepth: 0 }, 'strict').decodeRow(physical, collector)
    expect(collector.values).toEqual([row])
    expect(() => releasedV5SessionFormatCodec.encodeEvent(event('request/header', {
      header: { ...header, tools: [{ ...tool, deferLoading: false }] },
    }))).toThrow(/deferLoading must be true/)
  })

  it('shares V4 request tools with no extension fields and leaves malformed tools decoder-owned', () => {
    for (const header of [null, {}, { tools: null }, { tools: [{ name: 'echo', description: 'Echo', parameters: {} }, null] }]) {
      const row = event('request/header', { header })
      expect(migrateV4EventContent(row)).toBe(row)
    }
  })

  it('leaves missing message sources for native admission to reject', () => {
    const row = event('user/message', { id: 'missing-source', role: 'user', content: [] })
    const converted = migrate(row)
    expect(converted).toBe(row)
    expect(() => { assertV5MessageSources(converted) }).toThrow(/producer-owned source kind/)
  })

  it('rejects non-array content at the durable conversion boundary', () => {
    expect(() => migrateV4Content({}, 'sample')).toThrow(/content must be an array/)
  })

  it.each([null, {}, { type: 4 }])('rejects type-invalid content %j', (block) => {
    expect(() => migrateV4Content([block], 'sample')).toThrow(/string type tags/)
  })

  it('rejects a stream start without a string blockType', () => {
    expect(() => migrateV4EventContent(event('assistant/attempt', { stream: [{ type: 'chunk', chunk: { type: 'block-start', index: 0 } }] }))).toThrow(/blockType must be a string/)
  })
})

describe('native V5 opaque content', () => {
  it.each(['system', 'user'])('round trips %s extension content', (role) => {
    const message = { ...user, role, source: { kind: role === 'system' ? 'system-prompt' : 'user' }, content: [convertedBlock, { type: 'plugin:future', content: [wrapper] }] }
    const row = event(`${role}/message`, role === 'user' ? message : { turn: 1, step: 1, message })
    const physical = releasedV5SessionFormatCodec.encodeEvent(row)
    const collector = new SessionFormatEventCollector()
    releasedV5SessionFormatCodec.createDecoder({ type: 'session', version: 5, id: 'native', createdAt: 0, isSeeded: false, delegationDepth: 0 }, 'strict').decodeRow(physical, collector)
    expect(collector.values).toEqual([row])
  })
})

describe('unknown V4 event identities', () => {
  it.each(['future', '\ud800'])('namespaces %j while retaining opaque data and envelope fields', (type) => {
    const row = { ...event(type, { message: user, content: [wrapper] }), ignorable: true, sourceEventSeqs: [0], surfaceOp: 'append', extra: { saved: true } } as SessionFormatEvent
    const expected = { ...row, type: `plugin:${type}` }
    expect(migrate(row)).toEqual(expected)
    expect(expected.data).toBe(row.data)
    expect(namespaceV4OpaqueEvent(expected)).toBe(expected)
    expect(migrate(expected)).toEqual(expected)
  })

  it('leaves incomplete delivery payloads for generation validation', () => {
    for (const data of [null, {}, { sessionFormatVersion: '4' }]) {
      const row = event('session-log-deepseek/delivery-accepted', data)
      expect(namespaceV4OpaqueEvent(row)).toBe(row)
    }
  })

  it('leaves required unknown event identities for the migration stage to reject', () => {
    const unknown = event('future', {})
    expect(namespaceV4OpaqueEvent(unknown)).toBe(unknown)
    const known = event('turn/start', { turn: 1 })
    expect(namespaceV4OpaqueEvent(known)).toBe(known)
  })
})
