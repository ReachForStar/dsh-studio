/** Host entry: the a2a status plugin contributes no host-side behavior. */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-a2a-status host entry', () => {
  it('applies without touching a context', () => {
    expect(apply).toBeTypeOf('function')
    apply()
  })
})
