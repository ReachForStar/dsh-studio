/** Historical restoration for collecting migration prerequisites without recursively opening current Sessions. */

import { RELEASED_V4_EVENT_TYPES } from '@deepseek-ai/dsh-session-format-v4-to-v5'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { releasedV3SessionFormatCodec, sessionFormatV2ToV3 } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertReleasedV4Header, createSessionFormatV3ToV4, releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'

/** V0–V4 decoding for historical child identity; never publishes or completes parent catalogs. */
export const historicalSessionFormatCatalog = createSessionFormatCatalog({
  currentVersion: 4,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec, releasedV3SessionFormatCodec, releasedV4SessionFormatCodec],
  currentEncoder: releasedV4SessionFormatCodec,
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3, createSessionFormatV3ToV4([])],
  restoreCurrent: artifact => restoreReleasedV4Artifact(artifact, RELEASED_V4_EVENT_TYPES),
  restoreTransformedCurrent: artifact => restoreReleasedV4Artifact(artifact, RELEASED_V4_EVENT_TYPES),
  restoreCurrentHeader(header) {
    assertReleasedV4Header(header)
    return header
  },
})
