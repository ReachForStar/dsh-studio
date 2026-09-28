/** Bind parent-specific child evidence into the static first-party migration inventory. */

import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCatalog, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatV3ToV4, sessionFormatV3ToV4 } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { createSessionFormatV4ToV5, sessionFormatV4ToV5 } from '@deepseek-ai/dsh-session-format-v4-to-v5'
import { sessionFormatCatalogOptions } from './generated.ts'

/**
 * Assemble a catalog whose child-completing V3→V4 and V4→V5 edges know one parent's historical children.
 * @param children - complete child evidence retained unchanged for the catalog's lifetime; an empty array declares no children.
 * @returns a catalog with independent restore state per artifact and unchanged current-format readers.
 */
export function createSessionFormatCatalogWithChildren(children: readonly SessionFormatJsonValue[]): SessionFormatCatalog {
  const v3ToV4 = createSessionFormatV3ToV4(children)
  const v4ToV5 = createSessionFormatV4ToV5(children)
  return createSessionFormatCatalog({
    ...sessionFormatCatalogOptions,
    migrations: sessionFormatCatalogOptions.migrations.map(edge =>
      edge === sessionFormatV3ToV4 ? v3ToV4
        : edge === sessionFormatV4ToV5 ? v4ToV5
          : edge),
  })
}
