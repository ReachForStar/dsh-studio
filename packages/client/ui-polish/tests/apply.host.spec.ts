/** ui-polish node half: registers the background settings namespace. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply } from '../src/index.ts'
import { BACKGROUND_SETTINGS_NAMESPACE, PolishSettingsSchema } from '../src/background-settings.ts'

describe('ui-polish host', () => {
  it('registers the background settings namespace when the settings service is present', async () => {
    const ctx = new Context()
    const register = vi.fn()
    ctx.provide('settings', { register } as never)
    await ctx.plugin({ apply }).await()
    expect(register).toHaveBeenCalledWith(
      settingsNamespace(BACKGROUND_SETTINGS_NAMESPACE),
      PolishSettingsSchema,
    )
  })
})
