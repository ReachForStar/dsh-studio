/** The path arithmetic the file tree uses for keys and containment. */
import { describe, expect, it } from 'vitest'
import { childPath, isUnder } from '../src/client/paths.ts'

describe('paths', () => {
  it('treats the filesystem root as the ancestor of every absolute path', () => {
    expect(isUnder('/work/a', '')).toBe(true)
    expect(isUnder('/work', '/')).toBe(true)
    expect(isUnder('/work/a', '/')).toBe(true)
  })

  it('requires a strict descendant and ignores trailing separators', () => {
    expect(isUnder('/work/a', '/work')).toBe(true)
    expect(isUnder('/work/a', '/work/')).toBe(true)
    expect(isUnder('/work', '/work')).toBe(false)
    expect(isUnder('/workspace/a', '/work')).toBe(false)
    expect(childPath('/work/', 'a')).toBe('/work/a')
    expect(childPath('/', 'a')).toBe('/a')
  })
})
