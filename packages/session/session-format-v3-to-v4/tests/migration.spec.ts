import { describe, expect, it } from 'vitest'
import { createSessionFormatCatalog, SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import {
  releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1,
} from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import {
  assertReleasedV3Header, releasedV3SessionFormatCodec, sessionFormatV2ToV3,
} from '@deepseek-ai/dsh-session-format-v2-to-v3'
import {
  assertReleasedV4Header, assertV4Event, releasedV4SessionFormatCodec, restoreReleasedV4Artifact,
  sessionFormatV3ToV4,
} from '../src/index.ts'

const header: SessionFormatHeader = { version: 3, id: 'v4-identity', createdAt: 1, isSeeded: false, delegationDepth: 0 }
/** Physical header line the catalog decodes; the logical header drops its row tag. */
const physicalHeader = { type: 'session', ...header }

const peerMessage = (over: Record<string, unknown> = {}) => ({
  message: {
    id: 'peer-1',
    role: 'assistant',
    source: { kind: 'a2a-seat', role: 'tianliang', agent: 'opencode', skill: 'analysis' },
    content: [{ type: 'text', text: '规划通过' }],
    ...over,
  },
})

const event = (
  type: string,
  data: SessionFormatEvent['data'],
  surfaceOp?: SessionFormatEvent['surfaceOp'],
): SessionFormatEvent => ({ type, seq: 0, time: 42, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) })

const dense = (events: readonly SessionFormatEvent[]) => events.map((e, seq) => ({ ...e, seq }))

function stage(source = header, sourceCut: number | undefined = source.isSeeded ? undefined : 0) {
  const target = sessionFormatV3ToV4.migrateHeader(source)
  return {
    target,
    value: sessionFormatV3ToV4.createStage({
      sourceHeader: source,
      targetHeader: target,
      sourceInheritedEventCount: sourceCut,
      sourceKind: 'decoded',
    }),
    collector: new SessionFormatEventCollector(),
  }
}

/** Vocabulary the migrated fixtures use; a required event outside it must be refused. */
const FIXTURE_KNOWN = new Set(['turn/start', 'step/start', 'session/end-seed', 'assistant/peer-message'])

function migrate(events: readonly SessionFormatEvent[]): SessionFormatArtifact {
  const h = stage()
  for (const e of dense(events)) h.value.transformEvent(e, h.collector)
  return restoreReleasedV4Artifact({
    header: h.target,
    inheritedEventCount: h.value.finish(h.collector),
    events: h.collector.values,
  }, FIXTURE_KNOWN)
}

/** Installed vocabulary: the v4 generation's own event plus the frozen predecessors. */
const KNOWN = new Set(['assistant/peer-message'])

const catalog = createSessionFormatCatalog({
  currentVersion: 4,
  codecs: [
    releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec,
    releasedV3SessionFormatCodec, releasedV4SessionFormatCodec,
  ],
  currentEncoder: releasedV4SessionFormatCodec,
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3, sessionFormatV3ToV4],
  restoreCurrent: artifact => restoreReleasedV4Artifact(artifact, KNOWN),
  restoreTransformedCurrent: artifact => restoreReleasedV4Artifact(artifact, KNOWN),
  restoreCurrentHeader(value) { assertReleasedV4Header(value); return value },
})

describe('v3 to v4 adjacent migration', () => {
  it('rewrites only the header version and keeps every event and coordinate verbatim', () => {
    const source = [event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 })]
    const artifact = migrate(source)
    expect(artifact.header).toEqual({ ...header, version: 4 })
    expect(artifact.events).toEqual(dense(source))
  })

  it('carries the tagged inherited cut from v3 into v4 coordinates', () => {
    const h = stage({ ...header, isSeeded: true })
    const events = dense([
      event('turn/start', { turn: 1 }),
      event('session/end-seed', { inherited: true }),
    ])
    for (const e of events) h.value.transformEvent(e, h.collector)
    expect(h.value.finish(h.collector)).toBe(1)
    expect(h.target.version).toBe(4)
  })

  it('admits the turn-free peer assistant message through the catalog', () => {
    const reader = catalog.createRestore(physicalHeader, { recovery: 'strict', validation: 'current' })
    reader.decodeRow(event('assistant/peer-message', peerMessage(), 'append'))
    const artifact = reader.finish()
    expect(artifact.header.version).toBe(4)
    expect(artifact.events).toHaveLength(1)
    expect(artifact.events[0]?.type).toBe('assistant/peer-message')
  })

  it('refuses a peer message that claims this Session model route', () => {
    expect(() => { assertV4Event(event('assistant/peer-message', {
      message: {
        id: 'peer-2', role: 'assistant',
        source: { kind: 'model', provider: 'amock', model: 'mock' },
        content: [{ type: 'text', text: 'no' }],
      },
    }, 'append')) })
      .toThrow(/must not claim a model source/)
  })

  it('refuses a peer message whose role is not assistant', () => {
    expect(() => { assertV4Event(event('assistant/peer-message', peerMessage({ role: 'user' }), 'append')) })
      .toThrow(/role must be assistant/)
  })

  it('requires the peer message to carry a surfaceOp marker', () => {
    expect(() => { assertV4Event(event('assistant/peer-message', peerMessage())) })
      .toThrow(/requires a surfaceOp marker/)
  })

  it('refuses an uninstalled required event type instead of silently skipping it', () => {
    const reader = catalog.createRestore(physicalHeader, { recovery: 'strict', validation: 'current' })
    reader.decodeRow(event('ordinary/not-installed', { future: true }))
    expect(() => { reader.finish() }).toThrow(/unknown event type/)
  })

  it('refuses v3 input in the v4 header validator and v4 input in the v3 one', () => {
    expect(() => { assertReleasedV4Header({ ...header, version: 3 }) }).toThrow(/expected format v4 header/)
    expect(() => { assertReleasedV3Header({ ...header, version: 4 }) }).toThrow(/expected format v3 header/)
  })
})
