/**
 * Background row slot store: a mirror of the background runtime value. The
 * plugin's apply-world change listener is the only writer; the row component
 * reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

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
