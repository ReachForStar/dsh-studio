// @vitest-environment jsdom
/** Background runtime: scope adoption, body painting, and write retraction. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stubSettingsScope, type StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { PolishSettings } from '../src/background-settings.ts'
import { BackgroundRuntime, BG_IMAGE_ATTRIBUTE } from '../src/client/background-runtime.ts'

const PNG = 'data:image/png;base64,QUJD'

function make(): { ctx: Context; runtime: BackgroundRuntime; host: StubSettingsScope<PolishSettings> } {
  const ctx = new Context()
  const host = stubSettingsScope<PolishSettings>()
  return { ctx, runtime: new BackgroundRuntime(ctx, host.scope), host }
}

afterEach(() => {
  document.body.removeAttribute(BG_IMAGE_ATTRIBUTE)
  document.body.removeAttribute('style')
})

describe('BackgroundRuntime', () => {
  it('defaults to no background and adopts a published Host value without writing back', () => {
    const { runtime, host } = make()
    expect(runtime.getBackgroundImage()).toBeNull()
    host.publish({ status: 'ready', value: { backgroundImage: PNG }, revision: 1, writable: true })
    expect(runtime.getBackgroundImage()).toBe(PNG)
    expect(host.set).not.toHaveBeenCalled()
  })

  it('paints the image onto the body and marks the document; null clears it', () => {
    const { runtime, host } = make()
    runtime.setBackgroundImage(PNG)
    expect(host.set).toHaveBeenCalledWith('backgroundImage', PNG)
    expect(document.body.hasAttribute(BG_IMAGE_ATTRIBUTE)).toBe(true)
    expect(document.body.style.getPropertyValue('background-image')).toBe(`url("${PNG}")`)
    expect(document.body.style.getPropertyValue('background-size')).toBe('cover')
    runtime.setBackgroundImage(null)
    expect(host.unset).toHaveBeenCalledWith('backgroundImage')
    expect(document.body.hasAttribute(BG_IMAGE_ATTRIBUTE)).toBe(false)
    expect(document.body.style.getPropertyValue('background-image')).toBe('')
  })

  it('notifies listeners on accepted changes and skips same-value writes', () => {
    const { runtime } = make()
    const listener = vi.fn()
    runtime.subscribe(listener)
    runtime.setBackgroundImage(PNG)
    expect(listener).toHaveBeenCalledTimes(1)
    runtime.setBackgroundImage(PNG)
    expect(listener).toHaveBeenCalledTimes(1)
    runtime.setBackgroundImage(null)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('dispose retracts the body writes and the attribute', () => {
    const { runtime } = make()
    runtime.setBackgroundImage(PNG)
    runtime.dispose()
    expect(document.body.hasAttribute(BG_IMAGE_ATTRIBUTE)).toBe(false)
    expect(document.body.style.getPropertyValue('background-image')).toBe('')
  })
})
