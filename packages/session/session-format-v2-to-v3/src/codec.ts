/** V3 framing with hard structural admission and recoverable canonical event validation. */

import { SessionFormatError, isSessionFormatJsonObject, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonObject,
} from '@deepseek-ai/dsh-session-format'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, assertV3EventAdmission } from './validation.ts'
import { assertV3Event, assertV3StructuralRow } from './payload.ts'

/** V3 codec validates structural rows before recovery and logical envelopes after source-event range decoding. */
export const releasedV3SessionFormatCodec = Object.freeze({
  version: 3,
  decodeHeader(value: unknown) {
    return { ...releasedV2SessionFormatCodec.decodeHeader(v2PhysicalHeader(value)), version: 3, ...v3BackendField(value) }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV2SessionFormatCodec.createDecoder(v2PhysicalHeader(value), recovery)
    let issue: SessionFormatError | undefined
    let acceptedInheritedCut: number | undefined
    return {
      header: { ...decoder.header, version: 3, ...v3BackendField(value) },
      decodeRow(row, context) {
        assertV3RowAdmission(row)
        decoder.decodeRow(row, {
          emitRun: context.emitRun.bind(context),
          emitEvent(event) {
            assertV3EventAdmission(event)
            if (issue === undefined) {
              try {
                assertV3Event(event)
              } catch (error: unknown) {
                // The frozen event validator reports every decoded JSON violation as SessionFormatError.
                const invalid = error as SessionFormatError
                if (recovery === 'strict') throw invalid
                issue = invalid
              }
            }
            if (issue !== undefined) {
              if (event.type === 'turn/end') throw issue
              return
            }
            if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
              && event.data['inherited'] === true) acceptedInheritedCut = event.seq
            context.emitEvent(event)
          },
        })
      },
      finish(context) {
        if (issue === undefined) return decoder.finish(context)
        if (decoder.header.isSeeded && acceptedInheritedCut === undefined) {
          throw new SessionFormatError('format v3 seeded Session lacks an accepted inherited end-seed marker')
        }
        if (!decoder.header.isSeeded && acceptedInheritedCut !== undefined) {
          throw new SessionFormatError('format v3 unseeded Session contains an inherited end-seed marker')
        }
        return acceptedInheritedCut ?? 0
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV3Header(header)
    // The frozen v2 encoder rejects the v3-only `backend` field, so it is
    // encoded through the v2 shape and re-attached on the v3 physical line.
    const { backend: v3Backend, ...v2Fields } = header
    const v2Line = releasedV2SessionFormatCodec.encodeHeader({ ...v2Fields, version: 2 }, inheritedEventCount)
    return {
      ...v2Line,
      ...v3Backend === undefined ? {} : { backend: v3Backend },
      version: 3,
    }
  },
  encodeEvent(event) {
    assertV3EventAdmission(event)
    assertV3Event(event)
    return releasedV2SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Validate owned V3 admission rules before a scanner or codec can discard a recoverable tail.
 * This checks only identified structural payloads; physical source-event ranges still belong to decoding.
 * @param row - parsed physical row, before envelope or compressed-range decoding.
 */
export function assertV3RowAdmission(row: unknown): void {
  assertV3StructuralRow(row)
  if (typeof row === 'object' && row !== null && !Array.isArray(row)) assertV3EventAdmission(row as SessionFormatEvent)
}

function v2PhysicalHeader(value: unknown): SessionFormatHeader {
  const header = snapshotSessionFormatJson(value, 'format v3 physical header')
  if (!isSessionFormatJsonObject(header) || header['version'] !== 3) {
    throw new SessionFormatError('expected format v3 physical Session header')
  }
  // `backend` is the v3-only optional routing field; the frozen v2 physical
  // shape does not know it, so it is stripped before the v2 key check and
  // re-attached by the v3 codec callers.
  const { backend: _v3Backend, ...v2Shape } = header
  return { ...v2Shape, version: 2 } as SessionFormatHeader
}

/** The v3-only optional `backend` field carried on the physical header line, if any. */
function v3BackendField(value: unknown): SessionFormatJsonObject {
  const header = snapshotSessionFormatJson(value, 'format v3 physical header')
  if (!isSessionFormatJsonObject(header) || header['backend'] === undefined) return {}
  return { backend: header['backend'] }
}
