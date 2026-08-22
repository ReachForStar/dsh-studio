// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SshInvariant from '../src/invariant.ts'

describe('ui-ssh invariant companion', () => {
  it('reserves the package name and releases it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(SshInvariant)
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-client-ui-ssh', () => {}))
      .toThrow(/already registered/)
    await fiber.dispose()
    // The reservation is released: re-registration succeeds.
    ctx.invariants.register('@deepseek-ai/dsh-client-ui-ssh', () => {})
    await ctx.fiber.dispose()
  })
})
