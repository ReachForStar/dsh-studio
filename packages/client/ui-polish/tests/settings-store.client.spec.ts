/** Background row store: snapshot-mirror action and the revision guard. */
import { describe, expect, it } from 'vitest'
import { createBackgroundRowStore } from '../src/client/settings-store.ts'

describe('createBackgroundRowStore', () => {
  it('init shape: no background image, revision at -1', () => {
    const store = createBackgroundRowStore().create()
    expect(store.getSnapshot()).toEqual({ backgroundImage: null, revision: -1 })
  })

  it('sync mirrors the background image and advances the revision', () => {
    const store = createBackgroundRowStore().create()
    store.actions.sync('data:image/png;base64,x', 0)
    expect(store.getSnapshot()).toEqual({ backgroundImage: 'data:image/png;base64,x', revision: 0 })
    store.actions.sync(null, 2)
    expect(store.getSnapshot().backgroundImage).toBeNull()
    expect(store.getSnapshot().revision).toBe(2)
  })

  it('revision guard drops stale and duplicate writes', () => {
    const store = createBackgroundRowStore().create()
    store.actions.sync('data:image/png;base64,x', 3)
    store.actions.sync(null, 2)
    store.actions.sync('data:image/png;base64,y', 3)
    expect(store.getSnapshot().backgroundImage).toBe('data:image/png;base64,x')
    expect(store.getSnapshot().revision).toBe(3)
  })
})
