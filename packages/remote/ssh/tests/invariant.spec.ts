/**
 * Invariant companion of `@deepseek-ai/dsh-ssh`: a document edited externally
 * into duplicate ids or names must fail loud through the settings commit path.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import * as SshInvariant from '../src/invariant.ts'
import { SSH_SETTINGS_NAMESPACE } from '../src/index.ts'
import { StubSshService } from './stub-service.ts'

async function setup(withSsh: boolean): Promise<{ ctx: Context; settings: MemorySettings }> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SshInvariant)
  await ctx.plugin(MemorySettings)
  if (withSsh) await ctx.plugin(StubSshService)
  return { ctx, settings: ctx.settings as MemorySettings }
}

describe('ssh invariants', () => {
  it('fails a settings/updated emission without a live ssh service', async () => {
    const { ctx } = await setup(false)
    expect(() => {
      ctx.emit('settings/updated', SSH_SETTINGS_NAMESPACE, { connections: [] }, { connections: [] }, 'update')
    }).toThrow(/without a live ssh service/)
  })

  it('fails an externally edited document with duplicate connection names', async () => {
    const { settings } = await setup(true)
    expect(() => {
      settings.pushExternal({
        [SSH_SETTINGS_NAMESPACE]: {
          connections: [
            { id: 'a', name: 'dup', host: 'one', port: 22, username: 'u', auth: { kind: 'password', password: 'x' }, connectTimeoutMs: 10_000 },
            { id: 'b', name: 'dup', host: 'two', port: 22, username: 'u', auth: { kind: 'password', password: 'x' }, connectTimeoutMs: 10_000 },
          ],
        },
      })
    }).toThrow(/duplicate connection names/)
  })

  it('fails an externally edited document with duplicate connection ids', async () => {
    const { settings } = await setup(true)
    expect(() => {
      settings.pushExternal({
        [SSH_SETTINGS_NAMESPACE]: {
          connections: [
            { id: 'a', name: 'one', host: 'h', port: 22, username: 'u', auth: { kind: 'password', password: 'x' }, connectTimeoutMs: 10_000 },
            { id: 'a', name: 'two', host: 'h', port: 22, username: 'u', auth: { kind: 'password', password: 'x' }, connectTimeoutMs: 10_000 },
          ],
        },
      })
    }).toThrow(/duplicate connection ids/)
  })

  it('ignores settings/updated emissions for other namespaces', async () => {
    const { ctx } = await setup(true)
    expect(() => {
      ctx.emit('settings/updated', settingsNamespace('other'), {}, {}, 'update')
    }).not.toThrow()
  })

  it('accepts a well-formed external document', async () => {
    const { settings } = await setup(true)
    expect(() => {
      settings.pushExternal({
        [SSH_SETTINGS_NAMESPACE]: {
          connections: [
            { id: 'a', name: 'one', host: 'h', port: 22, username: 'u', auth: { kind: 'password', password: 'x' }, connectTimeoutMs: 10_000 },
          ],
        },
      })
    }).not.toThrow()
  })
})
