import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertReleasedV5Header, assertV5RowAdmission, releasedV5SessionFormatCodec, restoreReleasedV5Artifact } from '../src/index.ts'

const header = { version: 5, id: 'parent', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const fact: SessionFormatEvent = { type: 'feedback/record', seq: 0, time: 1, data: { text: 'retained' } }
const catalog: SessionFormatEvent = { type: 'subagent/catalog', seq: 0, time: 1, data: { version: 0, childId: 'child', childCreatedAt: 2, mode: 'one-shot' } }
const types = new Set(['subagent/catalog', 'feedback/record', 'session-log-deepseek/delivery-accepted', 'session/end-seed'])
const delivery = (version: number | undefined, sessionId = header.id): SessionFormatEvent => ({
  type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2,
  data: { sessionId, throughSeq: 0, ...(version === undefined ? {} : { sessionFormatVersion: version }) },
})

function restore(events: readonly SessionFormatEvent[], sourceHeader = header) {
  return restoreReleasedV5Artifact({ header: sourceHeader, events, inheritedEventCount: 0 }, types)
}

describe('V5 framing and restoration', () => {
  it('reuses released V2 physical framing and round trips native V5 rows', () => {
    const physical = releasedV5SessionFormatCodec.encodeHeader(header, 0)
    expect(physical).toEqual({ type: 'session', ...header })
    expect(releasedV5SessionFormatCodec.decodeHeader(physical)).toEqual(header)
    const decoder = releasedV5SessionFormatCodec.createDecoder(physical, 'strict')
    const output = new SessionFormatEventCollector()
    expect(decoder.header).toEqual(header)
    const row = releasedV5SessionFormatCodec.encodeEvent(fact)
    expect(row).toEqual(releasedV2SessionFormatCodec.encodeEvent(fact))
    decoder.decodeRow(row, output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([fact])
    const artifact = { header, events: output.values, inheritedEventCount: 0 }
    expect(restoreReleasedV5Artifact(artifact, types)).toBe(artifact)
  })

  it('rejects mismatched versions and malformed logical and physical metadata', () => {
    expect(() => { assertReleasedV5Header({ ...header, version: 4 }) }).toThrow('v5 header')
    expect(() => { assertReleasedV5Header({ ...header, createdAt: -1 }) }).toThrow('createdAt')
    expect(() => releasedV5SessionFormatCodec.decodeHeader(null)).toThrow('v5 physical')
    expect(() => releasedV5SessionFormatCodec.createDecoder({ ...header, version: 4 }, 'strict')).toThrow('v5 physical')
    expect(() => releasedV5SessionFormatCodec.decodeHeader({ type: 'session', ...header, extra: 1 })).toThrow(/field|member/)
  })

  it('rejects malformed optional and required native header fields', () => {
    const { id: _id, ...missingId } = header
    const malformed = [
      [missingId, 'lacks required field id'],
      [{ ...header, extra: true }, 'unexpected field extra'],
      [{ ...header, id: 7 }, 'id must be a string'],
      [{ ...header, isSeeded: 'no' }, 'isSeeded must be boolean'],
      [{ ...header, cwd: 'relative' }, 'cwd must be absolute'],
      [{ ...header, cwd: 7 }, 'cwd must be absolute'],
      [{ ...header, parentSession: 7 }, 'parentSession must be a string'],
      [{ ...header, agentPreset: 7 }, 'agentPreset must be a string'],
      [{ ...header, origin: 'parent' }, 'origin must be "subagent"'],
    ] as const
    for (const [value, message] of malformed) {
      expect(() => { assertReleasedV5Header(value) }).toThrow(message)
    }
  })

  it('rejects released wrapper rows before structural recovery can admit them', () => {
    const wrapperRow: SessionFormatEvent = {
      type: 'tool/result', seq: 0, time: 1, data: { message: { role: 'user' } },
    }
    expect(() => { assertV5RowAdmission(wrapperRow) }).toThrow(/first-class message/)
  })

  it('retains predecessor and future delivery generations without activating their watermarks', () => {
    for (const version of [undefined, 0, 1, 2, 3, 4, 6]) {
      const marker = { ...delivery(version, 'foreign'), data: { ...delivery(version).data as SessionFormatJsonObject, sessionId: 'foreign', throughSeq: 500 } }
      expect(restore([fact, marker]).events[1]).toBe(marker)
    }
    const current = delivery(5)
    expect(restore([fact, current]).events[1]).toBe(current)
    expect(() => restore([fact, delivery(5, 'foreign')])).toThrow('wrong Session')
  })

  it('rejects malformed active delivery coordinates and malformed generation identifiers', () => {
    const marker = delivery(5)
    const data = marker.data as SessionFormatJsonObject
    for (const throughSeq of [-1, 1, 1.5]) {
      expect(() => restore([fact, { ...marker, data: { ...data, throughSeq } }])).toThrow('throughSeq')
    }
    for (const sessionId of ['', null, 3]) {
      expect(() => restore([fact, { ...marker, data: { ...data, sessionId } }])).toThrow('nonempty')
    }
    for (const sessionFormatVersion of [-1, -0, 1.5, '5', null]) {
      expect(() => restore([fact, { ...marker, data: { ...data, sessionFormatVersion } }])).toThrow('sessionFormatVersion')
    }
    expect(() => restore([fact, { ...marker, data: null }])).toThrow('data must be an object')
    const reader = sessionFormatCatalog.createRestore({ type: 'session', ...header }, { recovery: 'strict', validation: 'current' })
    reader.decodeRow(fact)
    reader.decodeRow({ ...marker, data: { ...data, throughSeq: 1 } })
    expect(() => reader.finish()).toThrow('throughSeq')
  })

  it('preserves inherited and local events and admits foreign active deliveries inside the seed only', () => {
    const inherited = delivery(5, 'ancestor')
    const artifact = {
      header: { ...header, isSeeded: true, parentSession: 'ancestor' }, inheritedEventCount: 2,
      events: [fact, inherited, { type: 'session/end-seed', seq: 2, time: 3, data: { inherited: true } }, { ...fact, seq: 3 }],
    }
    expect(restoreReleasedV5Artifact(artifact, types)).toBe(artifact)
    expect(() => restoreReleasedV5Artifact({ ...artifact, inheritedEventCount: 1 }, types)).toThrow('marker')
  })

  it('rejects invalid inherited cuts, sparse rows, and unseeded inherited markers', () => {
    expect(() => restoreReleasedV5Artifact({ header, inheritedEventCount: 1, events: [] }, types))
      .toThrow('exceeds its events')
    expect(() => restoreReleasedV5Artifact({ header, inheritedEventCount: 1, events: [fact] }, types))
      .toThrow('unseeded format v5 Session has inherited events')
    expect(() => restoreReleasedV5Artifact({ header, inheritedEventCount: 0,
      events: [{ ...fact, seq: 1 }] }, types)).toThrow('not dense')
    expect(() => restoreReleasedV5Artifact({ header, inheritedEventCount: 0,
      events: [{ type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true } }] }, types))
      .toThrow('unseeded Session contains an inherited end-seed marker')
  })

  it('preserves unknown ignorable values and requires installed vocabulary for unknown required events', () => {
    const opaque = { type: 'external/opaque', seq: 0, time: 1, data: { untouched: ['a', 3] }, ignorable: true }
    expect(restore([opaque]).events[0]).toBe(opaque)
    const required = { type: 'external/required', seq: 0, time: 1, data: null }
    expect(() => restore([required])).toThrow('unknown event type')
    const artifact = { header, events: [required], inheritedEventCount: 0 }
    expect(restoreReleasedV5Artifact(artifact, new Set([required.type]))).toBe(artifact)
  })

  it('refuses wrapper-shaped and malformed native tool results before recovery', () => {
    const wrapper = { type: 'tool/result', seq: 0, time: 1, data: { message: { id: 'result', role: 'user', source: { kind: 'tool', callId: 'call' }, content: [] } } }
    const malformed = { type: 'tool/result', seq: 0, time: 1, data: { message: { id: 'result', role: 'tool', source: { kind: 'tool', callId: 'call' }, toolCallId: 'call', content: [], isError: 'yes' } } }
    for (const row of [wrapper, malformed]) {
      expect(() => { assertV5RowAdmission(row) }).toThrow()
      const decoder = releasedV5SessionFormatCodec.createDecoder({ type: 'session', ...header }, 'recoverable')
      const output = new SessionFormatEventCollector()
      decoder.decodeRow(null, output)
      expect(() => { decoder.decodeRow(row, output) }).toThrow()
    }
  })

  it('leaves ordinary framing recovery to the released decoder', () => {
    expect(() => { assertV5RowAdmission(null) }).not.toThrow()
    expect(() => { assertV5RowAdmission(fact) }).not.toThrow()
    const decoder = releasedV5SessionFormatCodec.createDecoder({ type: 'session', ...header }, 'recoverable')
    const output = new SessionFormatEventCollector()
    decoder.decodeRow(fact, output)
    decoder.decodeRow(null, output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([fact])
  })
  it('rejects duplicate own catalog membership', () => {
    expect(() => restore([catalog, { ...catalog, seq: 1 }])).toThrow('duplicate catalog child')
  })

  it('keeps inherited catalog entries outside own uniqueness checks', () => {
    const artifact = { header: { ...header, isSeeded: true, parentSession: 'ancestor' }, inheritedEventCount: 1,
      events: [catalog, { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } }, { ...catalog, seq: 2 }] }
    expect(restoreReleasedV5Artifact(artifact, types)).toBe(artifact)
  })
})
