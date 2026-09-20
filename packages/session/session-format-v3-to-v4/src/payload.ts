/** Audited V4 admission and payload validation, independent of installed core Session types. */

import {
  SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject,
  sessionFormatCount, sessionFormatSafeInteger,
} from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { RELEASED_V2_EVENT_DISPOSITIONS } from '@deepseek-ai/dsh-session-format-v1-to-v2'

/**
 * V4 surface event names: the frozen V3 set plus `assistant/peer-message`, the
 * turn-free assistant message another agent produced outside this Session's loop.
 */
export const SURFACE_TYPES: ReadonlySet<string> = new Set([
  'system/message', 'user/message', 'assistant/message', 'assistant/peer-message', 'tool/result',
])

/** The V4-only event this generation admits. */
export const PEER_MESSAGE = 'assistant/peer-message'

/**
 * Require a JSON object at the durable input boundary.
 * @param value - decoded value.
 * @param label - diagnostic subject.
 * @returns the narrowed object.
 */
export function record(value: SessionFormatJsonValue | undefined, label: string): SessionFormatJsonObject {
  if (!isSessionFormatJsonObject(value)) throw new SessionFormatError(label + ' must be an object')
  return value
}

/**
 * Reject missing and unaudited members rather than guessing whether they contain coordinates.
 * @param value - decoded record.
 * @param required - required member names.
 * @param optional - additional admitted names.
 * @param label - diagnostic subject.
 */
export function keys(value: SessionFormatJsonObject, required: readonly string[], optional: readonly string[], label: string): void {
  const missing = required.find(key => !Object.hasOwn(value, key))
  const unexpected = Object.keys(value).find(key => !required.includes(key) && !optional.includes(key))
  if (missing !== undefined) throw new SessionFormatError(label + ' lacks required field ' + missing)
  if (unexpected !== undefined) throw new SessionFormatError(label + ' has unexpected field ' + unexpected)
}

/**
 * Validate one canonical V4 event without interpreting plugin-owned payloads or log relationships.
 * @param event - decoded logical event.
 * @param knownEventTypes - additional installed event types whose envelopes are interpreted.
 */
export function assertV4Event(event: SessionFormatEvent, knownEventTypes?: ReadonlySet<string>): void {
  const value = record(event, 'format v4 event')
  const subject = `format v4 ${event.type} at seq ${event.seq}`
  const known = SURFACE_TYPES.has(event.type)
    || RELEASED_V2_EVENT_DISPOSITIONS[event.type] !== undefined
    || event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch'
    || event.type === 'feedback/message-put' || event.type === 'feedback/message-delete'
    || knownEventTypes?.has(event.type) === true
  // Unknown required events stay opaque: their envelopes are admitted so a
  // vocabulary-aware reader can interpret them, not silently skipped.
  const opaque = !known
  keys(value, ['type', 'seq', 'time', 'data'],
    SURFACE_TYPES.has(event.type) || opaque ? ['ignorable', 'surfaceOp', 'sourceEventSeqs'] : ['ignorable'], subject)
  if (typeof event.type !== 'string') throw new SessionFormatError(`${subject} type must be a string`)
  sessionFormatCount(event.seq, `${subject} seq`)
  sessionFormatSafeInteger(event.time, `${subject} time`)
  if (Object.hasOwn(value, 'ignorable') && value['ignorable'] !== true) {
    throw new SessionFormatError(`${subject} ignorable must be true when present`)
  }
  if (SURFACE_TYPES.has(event.type)) {
    const operation = value['surfaceOp']
    if (operation === undefined) throw new SessionFormatError(`${subject} requires a surfaceOp marker`)
    if (operation !== 'append') {
      const replace = record(operation, `${subject} surfaceOp`)
      if (Object.keys(replace).length !== 3 || replace['op'] !== 'replace'
        || !Object.hasOwn(replace, 'startSeq') || !Object.hasOwn(replace, 'endSeq')) {
        throw new SessionFormatError(`${subject} requires exact replace fields op/startSeq/endSeq`)
      }
      for (const key of ['startSeq', 'endSeq']) {
        if (sessionFormatCount(replace[key], `${subject} surfaceOp ${key}`) >= event.seq) {
          throw new SessionFormatError(`${subject} replacement endpoints must reference earlier events`)
        }
      }
    }
    const sources = value['sourceEventSeqs']
    if ((event.type === 'assistant/message' || event.type === PEER_MESSAGE) && sources !== undefined) {
      throw new SessionFormatError(`${subject} embeds its message and cannot carry sourceEventSeqs`)
    }
    if (sources !== undefined) {
      if (!Array.isArray(sources) || sources.length === 0) {
        throw new SessionFormatError(`${subject} sourceEventSeqs must be a non-empty array`)
      }
      const seen = new Set<number>()
      for (const source of sources) {
        const seq = sessionFormatCount(source, `${subject} sourceEventSeqs member`)
        if (seq >= event.seq || seen.has(seq)) throw new SessionFormatError(`${subject} sourceEventSeqs must be unique earlier seqs`)
        seen.add(seq)
      }
    }
  }
  assertV4StructuralRow(event)
  assertCanonicalPayload(event)
}

/**
 * Reject V4 structural payload violations even beyond a recoverable physical-row failure.
 * @param value - raw physical row; ordinary rows retain the frozen decoder's recovery policy.
 */
export function assertV4StructuralRow(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  const row = value as SessionFormatJsonObject
  if (row['type'] === 'request/header') {
    const data = record(row['data'], 'request/header data')
    if (Object.hasOwn(record(data['header'], 'request header'), 'system')) {
      throw new SessionFormatUnsupportedMigrationError('format v4 request/header rejects retired header.system')
    }
  } else if (row['type'] === 'system/message') {
    const data = record(row['data'], 'system/message data')
    keys(data, ['turn', 'step', 'message'], [], 'system/message data')
    for (const coordinate of ['turn', 'step']) {
      if (sessionFormatCount(data[coordinate], coordinate) === 0) throw new SessionFormatError(coordinate + ' must be positive')
    }
    const message = record(data['message'], 'system message')
    keys(message, ['id', 'role', 'source', 'content'], [], 'system message')
    if (typeof message['id'] !== 'string' || message['id'].length === 0 || message['role'] !== 'system') {
      throw new SessionFormatError('system message requires an id and system role')
    }
    const source = record(message['source'], 'system source')
    if (source['kind'] !== 'plugin' || typeof source['plugin'] !== 'string' || source['plugin'].length === 0) {
      throw new SessionFormatError('system message requires plugin source')
    }
  }
  if (row['type'] === PEER_MESSAGE) assertPeerMessage(row['data'])
}

/**
 * Validate one peer-message payload: an assistant message with an attributed source and
 * no turn coordinates, because the producing agent ran outside this Session's turns.
 * @param value - decoded payload.
 */
export function assertPeerMessage(value: SessionFormatJsonValue | undefined): void {
  const data = record(value, PEER_MESSAGE + ' data')
  keys(data, ['message'], [], PEER_MESSAGE + ' data')
  const message = record(data['message'], 'peer message')
  keys(message, ['id', 'role', 'source', 'content'], [], 'peer message')
  if (typeof message['id'] !== 'string' || message['id'].length === 0) {
    throw new SessionFormatError('peer message requires a non-empty id')
  }
  if (message['role'] !== 'assistant') throw new SessionFormatError('peer message role must be assistant')
  if (!Array.isArray(message['content'])) throw new SessionFormatError('peer message content must be an array')
  const source = record(message['source'], 'peer message source')
  if (typeof source['kind'] !== 'string' || source['kind'].length === 0) {
    throw new SessionFormatError('peer message source requires a kind')
  }
  // The producing agent is never this Session's model: a model source here would
  // misattribute the producer and the usage accounting keyed off it.
  if (source['kind'] === 'model') {
    throw new SessionFormatError('peer message must not claim a model source')
  }
}

function assertCanonicalPayload(event: SessionFormatEvent): void {
  const subject = `format v4 ${event.type} at seq ${event.seq}`
  if (event.type === 'request/header') {
    const data = record(event.data, `${subject} data`)
    const header = record(data['header'], `${subject} header`)
    if (Array.isArray(header['tools']) && header['tools'].length === 0
      || isSessionFormatJsonObject(header['adapterDefaults']) && Object.keys(header['adapterDefaults']).length === 0) {
      throw new SessionFormatError(`${subject} empty optional header fields must be omitted`)
    }
  }
  if (event.type !== 'tool/result') return
  const data = record(event.data, `${subject} data`)
  if (data['error'] === undefined) return
  const message = record(data['message'], `${subject} message`)
  const content = message['content']
  if (!Array.isArray(content) || content.length !== 1 || !isSessionFormatJsonObject(content[0])
    || content[0]['type'] !== 'tool-result' || content[0]['isError'] !== true) {
    throw new SessionFormatError(`${subject} carries error metadata for a non-error tool result`)
  }
}
