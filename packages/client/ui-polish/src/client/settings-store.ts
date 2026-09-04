/**
 * Background row slot store: a mirror of the background runtime value. The
 * plugin's apply-world change listener is the only writer; the row component
 * reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Store state mirrored from the background runtime. */
export interface BackgroundRowState {
  /** Uploaded background image data URL, or null when none is set. */
  backgroundImage: string | null
  /** Runtime revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type BackgroundRowActions = {
  sync: (draft: BackgroundRowState, backgroundImage: string | null, revision: number) => void
}

/**
 * Declares the background row state and write surface.
 * @returns the store handle.
 */
export function createBackgroundRowStore(): EngineStoreHandle<BackgroundRowState, BackgroundRowActions> {
  return defineStore({
    init: (): BackgroundRowState => ({ backgroundImage: null, revision: -1 }),
    actions: {
      sync: (d, backgroundImage: string | null, revision: number) => {
        if (revision <= d.revision) return
        d.backgroundImage = backgroundImage
        d.revision = revision
      },
    },
  })
}

/** Compaction row store state: the chosen pressure ratio, or null for the harness default. */
export interface CompactionRowState {
  /** Ratio × 1, or null when unset (harness default applies). */
  ratio: number | null
  /** Runtime revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type CompactionRowActions = {
  sync: (draft: CompactionRowState, ratio: number | null, revision: number) => void
}

/**
 * Declares the compaction row state and write surface. The writer is the
 * plugin's apply-world change listener; the row reads via props.useStore.
 * @returns the store handle.
 */
export function createCompactionRowStore(): EngineStoreHandle<CompactionRowState, CompactionRowActions> {
  return defineStore({
    init: (): CompactionRowState => ({ ratio: null, revision: -1 }),
    actions: {
      sync: (d, ratio: number | null, revision: number) => {
        if (revision <= d.revision) return
        d.ratio = ratio
        d.revision = revision
      },
    },
  })
}

/** Pricing row store state: the visible card JSON text and whether a user card exists. */
export interface PricingRowState {
  /** Card JSON text the row shows (the user card when set, else the formatted seed). */
  currentJson: string
  /** Whether a user card is currently set (false = the seed card applies). */
  hasCustom: boolean
  /** Runtime revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type PricingRowActions = {
  sync: (draft: PricingRowState, currentJson: string, hasCustom: boolean, revision: number) => void
}

/**
 * Declares the pricing row state and write surface. The writer is the
 * plugin's apply-world change listener; the row reads via props.useStore.
 * @returns the store handle.
 */
export function createPricingRowStore(): EngineStoreHandle<PricingRowState, PricingRowActions> {
  return defineStore({
    init: (): PricingRowState => ({ currentJson: '', hasCustom: false, revision: -1 }),
    actions: {
      sync: (d, currentJson, hasCustom, revision) => {
        if (revision <= d.revision) return
        d.currentJson = currentJson
        d.hasCustom = hasCustom
        d.revision = revision
      },
    },
  })
}
