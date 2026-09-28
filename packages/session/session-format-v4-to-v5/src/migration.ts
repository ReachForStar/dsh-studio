/** Append historical child facts after converting V4 source events to V5. */

import { defineSessionFormatMigration, SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatEventRun, SessionFormatJsonObject, SessionFormatJsonValue, SessionFormatMigration, SessionFormatMigrationContext, SessionFormatMigrationStage, SessionFormatMigrationStageInput } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { mapEventMessages, rewriteV4MessageSource } from './sources.ts'
import { liftToolResult } from './tool-role.ts'
import { migrateV4EventContent } from './content.ts'
import { namespaceV4OpaqueEvent, RELEASED_V4_EVENT_TYPES } from './extension-identities.ts'
import { assertReleasedV5Header, validateDeliveryAccepted } from './validation.ts'
import { catalogFact, childCatalogSource, childCatalogFact, childCatalogSubject } from './facts.ts'
import { remapV4References } from './references.ts'

/** Header-only migration declaration; body restoration requires explicit child evidence. */
export const sessionFormatV4ToV5 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v4-to-v5',
  fromVersion: 4,
  toVersion: 5,
  migrateHeader(header) {
    assertReleasedV4Header(header)
    return { ...header, version: 5 }
  },
  createStage() {
    throw new SessionFormatUnsupportedMigrationError('V4 catalog migration requires explicit historical child facts, including an empty array for a parent without children')
  },
  validateTargetHeader: assertReleasedV5Header,
})

/**
 * Bind one parent's historical child evidence to its V4→V5 migration.
 * @param children - complete child evidence retained unchanged for the lifetime of this declaration; an empty array declares no children.
 * @returns an adjacent migration that creates independent stages with the supplied evidence.
 */
export function createSessionFormatV4ToV5(children: readonly SessionFormatJsonValue[]): SessionFormatMigration {
  return defineSessionFormatMigration({
    ...sessionFormatV4ToV5,
    createStage: input => new ReleasedV4ToV5Stage(input, children),
  })
}

class ReleasedV4ToV5Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private readonly candidates: readonly SessionFormatJsonObject[]
  private readonly catalogs: SessionFormatJsonValue[] = []
  private cut: number | undefined
  private sourceCut: number | undefined
  private readonly mapping: number[] = []
  private turn: number | undefined
  private stepOpen = false
  private nextTurnSpliced = false
  private nextSeq = 0
  private time: number
  private foreignDeliverySeq: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput, children: readonly SessionFormatJsonValue[]) {
    this.candidates = children.map(childCatalogSource).sort((left, right) =>
      (left['childCreatedAt'] as number) - (right['childCreatedAt'] as number)
      || (left['childId'] === right['childId'] ? 0 : (left['childId'] as string) < (right['childId'] as string) ? -1 : 1))
    this.cut = input.sourceHeader.isSeeded ? undefined : 0
    this.sourceCut = this.cut
    if (!input.sourceHeader.isSeeded) this.headerInheritedEventCount = 0
    this.time = input.sourceHeader.createdAt
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.seq !== this.mapping.length) throw new SessionFormatError('V4 source events must be dense')
    const interrupted = this.observeRestart(event)
    if (interrupted !== undefined) {
      context.emitEvent({ type: 'turn/end', seq: this.nextSeq++, time: event.time,
        data: { turn: interrupted, reason: { kind: 'interrupted' } } })
    }
    const targetSeq = this.nextSeq++
    this.time = event.time
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data) && event.data['inherited'] === true) {
      if (!this.input.sourceHeader.isSeeded) throw new SessionFormatError('unseeded format v4 Session contains an inherited end-seed marker')
      this.sourceCut = event.seq
      this.cut = targetSeq
      this.catalogs.length = 0
    } else if (event.type === 'subagent/catalog') {
      this.catalogs.push(event.data)
    }
    const deliveryId = validateDeliveryAccepted(event, 4)
    if (event.type === 'session-log-deepseek/delivery-accepted') {
      if ((event.data as SessionFormatJsonObject)['sessionFormatVersion'] === 5) {
        throw new SessionFormatUnsupportedMigrationError('format v4 delivery marker claims target format v5')
      }
      if (deliveryId !== undefined && deliveryId !== this.input.sourceHeader.id) this.foreignDeliverySeq = event.seq
    }
    if (event['ignorable'] === true && !RELEASED_V4_EVENT_TYPES.has(event.type)) {
      // Unknown ignorable events keep their unvalidated envelope references: V4 admission never checked
      // `sourceEventSeqs` or `surfaceOp` on them and native V5 does not interpret either, so only `seq` moves.
      // An identity already namespaced by an earlier generation is retained verbatim.
      const opaque = namespaceV4OpaqueEvent(event)
      this.mapping.push(targetSeq)
      context.emitEvent(opaque.seq === targetSeq ? opaque : { ...opaque, seq: targetSeq })
      return
    }
    if (!RELEASED_V4_EVENT_TYPES.has(event.type)) {
      throw new SessionFormatUnsupportedMigrationError(
        `format v4 contains unknown event type ${JSON.stringify(event.type)} at seq ${event.seq}`,
      )
    }
    const remapped = remapV4References(event, targetSeq, this.mapping)
    this.mapping.push(targetSeq)
    const rewritten = mapEventMessages(remapped, (message) => {
      const source = message['source']
      if (!isSessionFormatJsonObject(source)) return message
      const converted = rewriteV4MessageSource(source, event.seq, message['role'])
      return converted === source ? message : { ...message, source: converted }
    })
    context.emitEvent(migrateV4EventContent(liftToolResult(rewritten)))
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  private observeRestart(event: SessionFormatEvent): number | undefined {
    const data = event.data
    const interrupted = event.type === 'turn/start' && this.turn !== undefined && !this.stepOpen
      && this.nextTurnSpliced && isSessionFormatJsonObject(data) && data['turn'] === this.turn + 1
      ? this.turn : undefined
    this.nextTurnSpliced = event.type === 'agent/inbox/spliced' && isSessionFormatJsonObject(data)
      && data['target'] === 'next-turn' && Array.isArray(data['inserted']) && data['inserted'].length > 0
    if (event.type === 'turn/start' && isSessionFormatJsonObject(data) && typeof data['turn'] === 'number') {
      this.turn = data['turn']
    } else if (event.type === 'turn/end') {
      // Target validation refuses a turn boundary that crosses an open step, so only `step/*` clears `stepOpen`.
      this.turn = undefined
    } else if (event.type === 'step/start') {
      this.stepOpen = true
    } else if (event.type === 'step/end') {
      this.stepOpen = false
    }
    return interrupted
  }

  finish(context: SessionFormatMigrationContext): number {
    const cut = sessionFormatCount(this.cut, 'V4 inherited event count')
    const sourceCut = sessionFormatCount(this.sourceCut, 'V4 source inherited event count')
    // Catalog payloads belong to this Session only after the final inherited cut.
    const existingCatalogs = new Map<string, SessionFormatJsonObject>()
    for (const data of this.catalogs) {
      const fact = catalogFact(data)
      const id = fact['childId'] as string
      if (existingCatalogs.has(id)) throw new SessionFormatUnsupportedMigrationError(`duplicate catalog child ${id}`)
      existingCatalogs.set(id, fact)
    }
    if (this.input.sourceInheritedEventCount !== undefined && sourceCut !== this.input.sourceInheritedEventCount) {
      throw new SessionFormatError('format v4 inherited cut disagrees with its source marker')
    }
    if (this.foreignDeliverySeq !== undefined
      && (this.input.sourceHeader.parentSession === undefined || this.foreignDeliverySeq >= sourceCut)) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
    for (const source of this.candidates) {
      const id = source['childId'] as string
      const existing = existingCatalogs.get(id)
      const fact = childCatalogFact(source)
      if (existing !== undefined) {
        if (existing['childCreatedAt'] !== source['childCreatedAt']) {
          throw new SessionFormatUnsupportedMigrationError(`${childCatalogSubject(source)} conflicts with its parent catalog`)
        }
        if (fact !== undefined && ['mode', 'label'].some(key => existing[key] !== fact[key])) {
          throw new SessionFormatUnsupportedMigrationError(`${childCatalogSubject(source)} conflicts with its parent catalog`)
        }
        continue
      }
      const entry = fact ?? { version: 1, childId: id, childCreatedAt: source['childCreatedAt'] as number, mode: 'unknown' }
      existingCatalogs.set(id, entry)
      context.emitEvent({ type: 'subagent/catalog',
        seq: this.nextSeq++, time: this.time, data: entry })
    }
    return cut
  }
}
