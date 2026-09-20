/** Native V4 validation: the V3 relationship rules plus the turn-free peer assistant message. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV3Header, restoreReleasedV3Artifact } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertV4Event, PEER_MESSAGE, record, SURFACE_TYPES } from './payload.ts'

/**
 * Validate v4 logical metadata with the released-v3 fields.
 * The generation admits one event type and changes no header field, so the
 * frozen v3 shape is the v4 shape with a higher version number.
 * @param header - decoded v4 Session header.
 */
export function assertReleasedV4Header(header: SessionFormatHeader): void {
  if (header.version !== 4) throw new SessionFormatError('expected format v4 header')
  assertReleasedV3Header({ ...header, version: 3 })
}

/**
 * Validate surface ownership, the unknown-event guard, the protected system head,
 * and event density for one detached v4 artifact. Message identities and payloads
 * are returned unchanged.
 *
 * This restorer does not delegate to the frozen v3 one. A predecessor validates
 * the envelope of a type it cannot classify as opaque, which is exactly what a
 * newer surface type needs; the frozen v3 rules instead read `assistant/peer-message`
 * as a known non-surface type and refuse its `surfaceOp`. The predecessor chain
 * owns those rules for its own artifacts, and the installed current validation runs
 * after this function on the live path.
 * @param artifact - detached v4 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact.
 */
export function restoreReleasedV4Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV4Header(artifact.header)
  let step: { readonly turn: unknown; readonly step: unknown } | undefined
  let head: number | undefined
  let hasSurface = false
  for (const [index, event] of artifact.events.entries()) {
    // The guard refuses a required event this build cannot interpret, which is the
    // failure the released generations refused through their own vocabulary.
    if (!knownEventTypes.has(event.type) && event['ignorable'] !== true) {
      throw new SessionFormatUnsupportedMigrationError(
        `format v4 contains unknown event type ${JSON.stringify(event.type)} at seq ${String(index)}`,
      )
    }
    assertV4Event(event, knownEventTypes)
    if (event.seq !== index) throw new SessionFormatError(`format v4 event ${String(index)} is not dense`)
    if (event.type === 'step/start') {
      const data = record(event.data, event.type)
      step = { turn: data['turn'], step: data['step'] }
    } else if (event.type === 'step/end' || event.type === 'turn/end') {
      step = undefined
    }
    if (event.type === 'system/message') {
      const data = record(event.data, 'system/message')
      if (step === undefined || step.turn !== data['turn'] || step.step !== data['step']) {
        throw new SessionFormatError('system/message does not match an open step')
      }
      const operation = event['surfaceOp']
      if (hasSurface && head === undefined) {
        throw new SessionFormatError('system/message requires a protected first surface head')
      }
      if (operation === 'append') {
        if (!hasSurface) head = event.seq
      } else {
        const replace = record(operation, 'system replacement')
        if (replace['startSeq'] === head || replace['endSeq'] === head) {
          if (replace['startSeq'] !== head || replace['endSeq'] !== head) {
            throw new SessionFormatError('system/message must replace exactly the current system head')
          }
          head = event.seq
        }
      }
    } else if (SURFACE_TYPES.has(event.type) && event['surfaceOp'] !== 'append') {
      const replace = record(event['surfaceOp'], 'surface replacement')
      if (replace['startSeq'] === head || replace['endSeq'] === head) {
        throw new SessionFormatError('surface replacement cannot shadow the protected system head')
      }
    }
    if (event.type === 'compaction/prune' || event.type === 'compaction/summary') {
      const seqs = record(event.data, event.type)['shadowedSeqs']
      if (Array.isArray(seqs) && seqs.some(seq => seq === head)) {
        throw new SessionFormatError('compaction cannot shadow the protected system head')
      }
    }
    if (SURFACE_TYPES.has(event.type)) hasSurface = true
  }
  // Delegate the frozen predecessor chain, naming this generation's surface type so
  // the frozen rules admit it as an opaque surface event instead of reading it as a
  // known non-surface type. The predecessor chain then owns the relationship checks
  // that are not this generation's to re-derive.
  restoreReleasedV3Artifact(
    { ...artifact, header: { ...artifact.header, version: 3 } },
    knownEventTypes,
    new Set([PEER_MESSAGE]),
  )
  return artifact
}

/** The V4-only event name, re-exported for callers that classify artifacts by hand. */
export { PEER_MESSAGE as RELEASED_V4_PEER_MESSAGE }
