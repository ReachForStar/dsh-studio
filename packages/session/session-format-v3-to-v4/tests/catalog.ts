/**
 * Fixed V0–V4 composition for released-edge tests, independent of the current V5 writer.
 *
 * This package is now a historical migration edge: `assistant/peer-message` moved to the
 * V4→V5 successor, so the current catalog chains past V4 and a live Session is native V5.
 * These tests exercise the released V3→V4 edge in isolation, so they reproduce the catalog
 * versions this package had when V4 was current — a V4-current reader, a V4-current reader
 * whose V3→V4 edge knows one parent's children, and a V3-current historical reader.
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCatalog, SessionFormatCatalogOptions, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, releasedV3SessionFormatCodec, restoreReleasedV3Artifact, sessionFormatV2ToV3 } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { RELEASED_V3_EVENT_TYPES, assertReleasedV4Header, createSessionFormatV3ToV4, releasedV4SessionFormatCodec, restoreReleasedV4Artifact, sessionFormatV3ToV4 } from '../src/index.ts'

const v4Options: SessionFormatCatalogOptions = {
  currentVersion: 4,
  codecs: [
    releasedV0SessionFormatCodec,
    releasedV1SessionFormatCodec,
    releasedV2SessionFormatCodec,
    releasedV3SessionFormatCodec,
    releasedV4SessionFormatCodec,
  ],
  currentEncoder: releasedV4SessionFormatCodec,
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3, sessionFormatV3ToV4],
  restoreCurrent: artifact => restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES),
  restoreTransformedCurrent: artifact => restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES),
  restoreCurrentHeader(header) {
    assertReleasedV4Header(header)
    return header
  },
}

/** Restore the released V4 result through its complete predecessor chain. */
export const sessionFormatCatalog = createSessionFormatCatalog(v4Options)

/**
 * Assemble a V4-current catalog whose V3→V4 edge knows one parent's historical children.
 * @param children - complete child evidence retained unchanged for the catalog's lifetime; an empty array declares no children.
 * @returns a catalog with independent restore state per artifact.
 */
export function createSessionFormatCatalogWithChildren(children: readonly SessionFormatJsonValue[]): SessionFormatCatalog {
  const migration = createSessionFormatV3ToV4(children)
  return createSessionFormatCatalog({
    ...v4Options,
    migrations: v4Options.migrations.map(edge => edge === sessionFormatV3ToV4 ? migration : edge),
  })
}

/** V0–V3 decoding for historical reads that must stop at native V3. */
export const historicalSessionFormatCatalog = createSessionFormatCatalog({
  currentVersion: 3,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec, releasedV3SessionFormatCodec],
  currentEncoder: releasedV3SessionFormatCodec,
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3],
  restoreCurrent: artifact => restoreReleasedV3Artifact(artifact, RELEASED_V3_EVENT_TYPES),
  restoreTransformedCurrent: artifact => restoreReleasedV3Artifact(artifact, RELEASED_V3_EVENT_TYPES),
  restoreCurrentHeader(header) {
    assertReleasedV3Header(header)
    return header
  },
})
