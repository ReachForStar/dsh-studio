/**
 * Host loader entry contract: the node half of a client plugin package
 * contributes nothing beyond the browser bundle.
 */

import { describe, expect, it } from 'vitest'
import * as UiSsh from '../src/index.ts'

describe('ui-ssh host half', () => {
  it('exports apply as a function and no default export', () => {
    expect(typeof UiSsh.apply).toBe('function')
    expect('default' in UiSsh).toBe(false)
  })

  it('applies the plugin body without throwing', () => {
    // The host half contributes nothing beyond the browser bundle; apply is
    // invoked directly so its empty body is covered as executable code.
    UiSsh.apply()
  })
})
