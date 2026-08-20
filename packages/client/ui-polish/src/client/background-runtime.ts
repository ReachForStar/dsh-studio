// Background runtime: owns the whole-app background image preference, persists
// it through the plugin's settings scope, paints it onto the body, and marks
// the document so the plugin's global token-override stylesheet turns the
// structural base surfaces transparent. Pure DOM writes; every write is
// retracted on clear and on dispose.

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { BACKGROUND_IMAGE_FIELD, type PolishSettings } from '../background-settings.ts'

/** Body attribute marking that a whole-app background image is active. */
export const BG_IMAGE_ATTRIBUTE = 'data-ds-bg-image'

/** Inline background properties written while an image is active. */
const BG_IMAGE_PROPERTIES = ['background-image', 'background-size', 'background-attachment', 'background-position'] as const

/**
 * Background preference owner and DOM painter. Reads go through
 * {@link getBackgroundImage} and {@link subscribe}; writes only through
 * {@link setBackgroundImage} (set for a data URL, unset for null).
 */
export class BackgroundRuntime {
  private backgroundImage: string | null = null
  private readonly listeners = new Set<() => void>()

  /**
   * @param ctx - owning context (scope subscription rides ctx.effect).
   * @param host - durable preference scope bound by the owning plugin.
   */
  constructor(
    ctx: Context,
    private readonly host: SettingsScope<PolishSettings>,
  ) {
    ctx.effect(() => host.subscribe(() => { this.adopt() }), 'ui-polish: background settings adoption')
    this.adopt()
  }

  /** The current background image data URL, or null when none is set.
   * @returns the served image URL or null.
   */
  getBackgroundImage(): string | null {
    return this.backgroundImage
  }

  /**
   * Observe background value changes.
   * @param listener - invoked after each accepted change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Set or clear the whole-app background image. A data URL is written through
   * the settings scope; null clears the field. Every accepted change repaints
   * the body and notifies listeners.
   * @param dataUrl - uploaded image data URL, or null to remove the background.
   */
  setBackgroundImage(dataUrl: string | null): void {
    if (this.backgroundImage === dataUrl) return
    this.backgroundImage = dataUrl
    if (dataUrl === null) void this.host.unset(BACKGROUND_IMAGE_FIELD)
    else void this.host.set(BACKGROUND_IMAGE_FIELD, dataUrl)
    this.paint()
    this.notify()
  }

  /** Adopt the scope's accepted durable value without writing it back. */
  private adopt(): void {
    const section = this.host.getSnapshot().value
    if (section === undefined) return
    const next = section.backgroundImage ?? null
    if (this.backgroundImage === next) return
    this.backgroundImage = next
    this.paint()
    this.notify()
  }

  /** Paint or clear the background on the body, setting `data-ds-bg-image`. */
  private paint(): void {
    const body = document.body
    if (this.backgroundImage === null) {
      body.removeAttribute(BG_IMAGE_ATTRIBUTE)
      for (const name of BG_IMAGE_PROPERTIES) body.style.removeProperty(name)
      return
    }
    body.setAttribute(BG_IMAGE_ATTRIBUTE, '')
    body.style.setProperty('background-image', `url("${this.backgroundImage}")`)
    body.style.setProperty('background-size', 'cover')
    body.style.setProperty('background-attachment', 'fixed')
    body.style.setProperty('background-position', 'center')
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn()
  }

  /** Retract every body write this runtime made. */
  dispose(): void {
    const body = document.body
    body.removeAttribute(BG_IMAGE_ATTRIBUTE)
    for (const name of BG_IMAGE_PROPERTIES) body.style.removeProperty(name)
    this.listeners.clear()
  }
}
