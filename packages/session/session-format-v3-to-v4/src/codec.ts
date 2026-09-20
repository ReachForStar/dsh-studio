/** V4 framing: the frozen V3 codec plus this generation's admission and validation. */

import {
  SessionFormatError, isSessionFormatJsonObject, snapshotSessionFormatJson,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec, SessionFormatCurrentEncoder, SessionFormatEvent, SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import { releasedV3SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertV4Event, assertV4StructuralRow } from './payload.ts'
import { assertReleasedV4Header } from './validation.ts'

/**
 * V4 codec: the frozen V3 physical layer plus this generation's row and envelope
 * validation. This generation adds one event type and no physical header field,
 * so the delegation rewrites only the version number.
 */
export const releasedV4SessionFormatCodec = Object.freeze({
  version: 4,
  decodeHeader(value: unknown) {
    return { ...releasedV3SessionFormatCodec.decodeHeader(v3PhysicalHeader(value)), version: 4 }
  },
  createDecoder(value: unknown, recovery: Parameters<SessionFormatCodec['createDecoder']>[1]) {
    const decoder = releasedV3SessionFormatCodec.createDecoder(v3PhysicalHeader(value), recovery)
    return {
      header: { ...decoder.header, version: 4 },
      decodeRow(row: unknown, context: Parameters<ReturnType<SessionFormatCodec['createDecoder']>['decodeRow']>[1]) {
        assertV4RowAdmission(row)
        decoder.decodeRow(row, {
          emitRun: context.emitRun.bind(context),
          emitEvent(event) {
            // The frozen v3 wrapper ran its own admission first; this generation's
            // canonical rules need the decoded event, whose stored `sourceEventSeqs`
            // ranges are already expanded to seqs.
            assertV4Event(event)
            context.emitEvent(event)
          },
        })
      },
      finish(context: Parameters<ReturnType<SessionFormatCodec['createDecoder']>['finish']>[0]) {
        return decoder.finish(context)
      },
    }
  },
  encodeHeader(header: SessionFormatHeader, inheritedEventCount: Parameters<SessionFormatCurrentEncoder['encodeHeader']>[1]) {
    assertReleasedV4Header(header)
    const line = releasedV3SessionFormatCodec.encodeHeader({ ...header, version: 3 }, inheritedEventCount)
    return { ...line, version: 4 }
  },
  encodeEvent(event: SessionFormatEvent) {
    assertV4Event(event)
    return releasedV3SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Validate this generation's row-level admission before a scanner or codec discards a
 * recoverable tail. Only the structural payloads a raw row can answer are checked here:
 * a stored row's `sourceEventSeqs` may still be in range form until the decoder expands
 * it, and this generation adds no admission rule beyond structure.
 * @param row - parsed physical row, before envelope or compressed-range decoding.
 */
export function assertV4RowAdmission(row: unknown): void {
  assertV4StructuralRow(row)
}

/** Rewrite the v4 physical header for the frozen v3 decoder, which checks its own version. */
function v3PhysicalHeader(value: unknown): SessionFormatHeader {
  const header = snapshotSessionFormatJson(value, 'format v4 physical header')
  if (!isSessionFormatJsonObject(header) || header['version'] !== 4) {
    throw new SessionFormatError('expected format v4 physical Session header')
  }
  return { ...header, version: 3 } as unknown as SessionFormatHeader
}
