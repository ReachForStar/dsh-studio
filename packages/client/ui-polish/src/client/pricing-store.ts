// Pricing runtime: owns the model rate card that prices the session stats
// float. The built-in seed card in `model-pricing.json` is the default; a
// user-edited card persists as JSON text in the ui-polish settings document
// and re-prices the float immediately, without a rebuild. Reads go through
// {@link card}; writes only through {@link save} (validating) and {@link reset}.

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { MODEL_PRICING_FIELD, type PolishSettings } from '../background-settings.ts'
import { parseRateCard, SEED_RATE_CARD, type RateCardData } from './cost.ts'

/**
 * Model rate card owner: adopts the durable user card, serves the effective
 * card to the stats float, and persists validated edits through the scope.
 */
export class PricingRuntime {
  private effective: RateCardData = SEED_RATE_CARD

  /**
   * @param ctx - owning context (scope subscription rides ctx.effect).
   * @param host - durable preference scope bound by the owning plugin.
   */
  constructor(
    ctx: Context,
    private readonly host: SettingsScope<PolishSettings>,
  ) {
    ctx.effect(() => host.subscribe(() => { this.adopt() }), 'ui-polish: pricing adoption')
    this.adopt()
  }

  /** The card currently pricing the float (the user card or the seed).
   * @returns the effective rate card.
   */
  getCard(): RateCardData {
    return this.effective
  }

  /** The durable JSON text of the user card, or null when unset.
   * @returns the persisted card JSON, or null.
   */
  getUserJson(): string | null {
    return this.host.getSnapshot().value?.modelPricing ?? null
  }

  /**
   * Validate and persist a user card. The scope write happens only after the
   * JSON parses; the effective card updates immediately.
   * @param json - rate card JSON text (the `model-pricing.json` shape).
   * @throws {Error} with a field-level message when the card is invalid.
   */
  save(json: string): void {
    const card = parseRateCard(json)
    this.effective = card
    void this.host.set(MODEL_PRICING_FIELD, json)
  }

  /** Clear the user card back to the built-in seed. */
  reset(): void {
    this.effective = SEED_RATE_CARD
    void this.host.unset(MODEL_PRICING_FIELD)
  }

  /** Adopt the scope's durable user card without writing it back. */
  private adopt(): void {
    const json = this.getUserJson()
    if (json === null) {
      this.effective = SEED_RATE_CARD
      return
    }
    try {
      this.effective = parseRateCard(json)
    } catch {
      // A corrupt persisted card falls back to the seed; the settings row
      // shows the durable text so the user can repair or reset it.
      this.effective = SEED_RATE_CARD
    }
  }
}
