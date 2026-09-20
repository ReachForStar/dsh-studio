/** The V3 to V4 adjacent migration: coordinates, identities, and payloads are unchanged. */

import {
  SessionFormatError, defineSessionFormatMigration, sessionFormatCount,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent, SessionFormatEventRun, SessionFormatMigrationContext, SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV3Header } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertV4Event, record } from './payload.ts'
import { assertReleasedV4Header } from './validation.ts'

/**
 * Admit the turn-free peer assistant message. This generation rewrites no event:
 * it adds one surface type, so every released v3 event stays valid v4 input and
 * the stage is the identity function over the source coordinates.
 */
export const sessionFormatV3ToV4 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v3-to-v4',
  fromVersion: 3,
  toVersion: 4,
  migrateHeader(header) {
    assertReleasedV3Header(header)
    return { ...header, version: 4 }
  },
  createStage(input) { return new ReleasedV3ToV4Stage(input) },
  validateTargetHeader: assertReleasedV4Header,
})

class ReleasedV3ToV4Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private emitted = 0
  private sourceCut: number | undefined
  private targetCut: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    assertReleasedV3Header(input.sourceHeader)
    this.sourceCut = input.sourceHeader.isSeeded ? undefined : 0
    this.targetCut = input.sourceHeader.isSeeded ? undefined : 0
    if (!input.sourceHeader.isSeeded) this.headerInheritedEventCount = 0
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.seq !== this.emitted) throw new SessionFormatError('format v3 source events must be dense')
    assertV4Event(event)
    if (event.type === 'session/end-seed' && record(event.data, event.type)['inherited'] === true) {
      if (!this.input.sourceHeader.isSeeded) {
        throw new SessionFormatError('format v3 unseeded Session contains an inherited end-seed marker')
      }
      this.sourceCut = event.seq
      this.targetCut = this.emitted
    }
    this.emitted += 1
    context.emitEvent(event)
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(_context: SessionFormatMigrationContext): number {
    const cut = sessionFormatCount(this.sourceCut, 'format v3 inherited end-seed marker')
    if (this.input.sourceInheritedEventCount !== undefined && this.input.sourceInheritedEventCount !== cut) {
      throw new SessionFormatError('format v3 inherited end-seed marker disagrees with its source cut')
    }
    return sessionFormatCount(this.targetCut, 'format v4 inherited event count')
  }
}
