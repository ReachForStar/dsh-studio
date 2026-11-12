// @vitest-environment jsdom
/** ExcalidrawPanel helpers: persisted app-state subset and scene fingerprints. */
import { describe, expect, it } from 'vitest'
import { sanitizeAppState, sceneFingerprint } from '../src/client/ExcalidrawPanel.tsx'

describe('sanitizeAppState', () => {
  it('keeps the document subset and drops runtime or non-serializable state', () => {
    const clean = sanitizeAppState({
      viewBackgroundColor: '#fff',
      gridSize: 20,
      scrollX: 10,
      zoom: { value: 1 },
      theme: 'dark',
      selectedElementIds: { a: true },
      activeTool: { type: 'selection' },
      map: new Map([['a', 1]]),
      set: new Set([1]),
      name: 'scene',
      missing: undefined,
    })
    expect(clean).toEqual({
      viewBackgroundColor: '#fff',
      gridSize: 20,
      scrollX: 10,
      zoom: { value: 1 },
      name: 'scene',
    })
  })

  it('drops persisted keys that carry a Map or a Set', () => {
    expect(sanitizeAppState({ gridSize: new Map([['a', 1]]), scrollX: new Set([1]), zoom: { value: 2 } }))
      .toEqual({ zoom: { value: 2 } })
  })
})

describe('sceneFingerprint', () => {
  it('returns null without an element array', () => {
    expect(sceneFingerprint(null)).toBeNull()
    expect(sceneFingerprint('x')).toBeNull()
    expect(sceneFingerprint({})).toBeNull()
    expect(sceneFingerprint({ elements: 'no' })).toBeNull()
  })

  it('keys on id, type, text, and count, ignoring runtime fields', () => {
    const first = sceneFingerprint({ elements: [
      { id: 'a', type: 'rectangle', seed: 1, versionNonce: 2, index: 9 },
      { id: 'b', type: 'text', text: 'hello', versionNonce: 3 },
    ] })
    const second = sceneFingerprint({ elements: [
      { index: 1, type: 'rectangle', id: 'a' },
      { text: 'hello', type: 'text', id: 'b' },
    ] })
    expect(first).toBe(second)
    expect(first).toBe('a:rectangle:|b:text:hello#2')
    expect(sceneFingerprint({ elements: [{ id: 'a' }, null, 7] })).toBe('a::|::|::#3')
  })
})
