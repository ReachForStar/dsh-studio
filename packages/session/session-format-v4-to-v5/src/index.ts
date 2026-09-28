/** Tool-role V4-to-V5 migration with native V5 framing and delivery validation. */

export { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
export * from './codec.ts'
export * from './migration.ts'
export { assertReleasedV5Header, assertReleasedV5Relationships, restoreReleasedV5Artifact } from './validation.ts'
export { historicalChildCatalogSource } from './facts.ts'
export { RELEASED_V3_EVENT_TYPES, RELEASED_V4_EVENT_TYPES } from './extension-identities.ts'
