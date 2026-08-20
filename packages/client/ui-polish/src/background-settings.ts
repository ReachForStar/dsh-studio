/** UI-polish preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the ui-polish plugin. */
export const BACKGROUND_SETTINGS_NAMESPACE = 'ui-polish'

/** Field carrying the served background image URL (`/bg/current`) or a legacy data URL. */
export const BACKGROUND_IMAGE_FIELD = 'backgroundImage'

/** Field carrying the automatic context-compaction pressure ratio (0.5–0.8; absent = harness default 0.8). */
export const COMPACTION_RATIO_FIELD = 'compactionThresholdRatio'

/** Field carrying the user-edited model rate card as JSON text (absent = the built-in seed card). */
export const MODEL_PRICING_FIELD = 'modelPricing'

/**
 * Upload cap for the background image in bytes. The image is persisted as a
 * file on disk (served at `/bg/current`); the bound keeps the on-disk file and
 * the upload request from growing unbounded.
 */
export const MAX_BACKGROUND_IMAGE_BYTES = 2 * 1024 * 1024

/** Durable section shared by the Host schema and the browser scope. */
export interface PolishSettings {
  /** Served background image URL (or a legacy data URL); absent when none is set. */
  backgroundImage?: string
  /** Automatic compaction pressure ratio; absent = harness default (0.8). */
  compactionThresholdRatio?: number
  /** User-edited model rate card as JSON text; absent = the built-in seed card. */
  modelPricing?: string
}

/** Durable schema; also the wire envelope the browser scope validates against. */
export const PolishSettingsSchema: z<PolishSettings> = z.object({
  // Schemastery object fields are optional by default; no `.optional()` call.
  [BACKGROUND_IMAGE_FIELD]: z.string(),
  [COMPACTION_RATIO_FIELD]: z.number().min(0.5).max(0.8),
  [MODEL_PRICING_FIELD]: z.string(),
})
