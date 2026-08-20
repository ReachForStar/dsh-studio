/**
 * ui-polish browser half: four standalone GUI enhancements that need no core
 * package changes —
 *  - whole-app background image (own settings namespace, own body painting,
 *    token-override transparency for the structural surfaces),
 *  - a session stats float with an estimated cost (a composer.dock entry that
 *    pins itself to the viewport's top-right via position:fixed),
 *  - a git panel as a conversation.view tab (right after the trajectory tab,
 *    talking to /git/* routes registered by the node half),
 *  - a floating file-mutation diff panel (a composer.dock entry that watches
 *    the session for newly settled write/edit calls and draws the applied
 *    change at the right edge).
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings scope Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ui-settings-general SlotMap merge (the settings.general.item entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the composer.dock entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BACKGROUND_SETTINGS_NAMESPACE, COMPACTION_RATIO_FIELD, type PolishSettings } from '../background-settings.ts'
import { BackgroundRuntime } from './background-runtime.ts'
import { BackgroundRow, type BackgroundRowInjected } from './BackgroundRow.tsx'
import { CompactionRow, type CompactionRowInjected } from './CompactionRow.tsx'
import { PricingRow, type PricingRowInjected } from './PricingRow.tsx'
import { createBackgroundRowStore } from './settings-store.ts'
import { createModelIndex, modelIndexDefinition, type ModelIndex } from './model-index.ts'
import { PricingRuntime } from './pricing-store.ts'
import { SEED_RATE_CARD } from './cost.ts'
import { StatsFloat } from './StatsFloat.tsx'
import { GitPanel } from './GitPanel.tsx'
import { ExcalidrawPanel } from './ExcalidrawPanel.tsx'
import { MutationDiffPanel } from './MutationDiffPanel.tsx'
import { en, zh, type PolishKey } from './locales.ts'

export type { BackgroundRowComponentProps, BackgroundRowInjected } from './BackgroundRow.tsx'
export type { BackgroundRowState } from './settings-store.ts'
export type { PolishKey } from './locales.ts'
export type { PolishSettings } from '../background-settings.ts'

/** Namespace owning this plugin's copy. */
export const NS = 'ui-polish'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The ui-polish surface's copy. */
    'ui-polish': PolishKey
  }
}

/**
 * Structural surfaces turn transparent while the whole-app background image is
 * active: overriding the base tokens makes every surface that paints them
 * (the app frame, conversation, details, and sidebar columns) yield to the
 * body-painted image. Content elements that need contrast (cards, code blocks,
 * buttons) keep their own non-base fills; this is the standalone plugin's
 * reach without touching core stylesheets.
 */
const AMBIENT_OVERRIDES = `
body[data-ds-bg-image] {
  --dsw-alias-bg-base: transparent;
  --dsw-specific-sidebar-fill: transparent;
}
/* This plugin owns the composer.dock readout: its floating stats panel carries
   a data-ui-polish-stats marker, so every other dock entry (the core's
   under-composer stats band) is hidden to avoid duplicating the session
   readout. */
[data-slot="conversation.composer.dock"] > *:not([data-ui-polish-stats]) {
  display: none;
}
`

/** Required services: settings transport plus slots/locale for the registrations. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope', 'conversationEvents']

/**
 * Client plugin body: bind the background preference, paint the body, and
 * register the three surface contributions.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  const host = ctx.settingsScope.bind<PolishSettings>({ namespace: BACKGROUND_SETTINGS_NAMESPACE })
  const background = new BackgroundRuntime(ctx, host)
  // Model rate card owner: shared by the stats float (pricing) and the
  // settings row (editing). One instance keeps the scope subscription single.
  const pricing = new PricingRuntime(ctx, host)

  // Global token overrides plus body-write retraction, both owned by this fiber.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.uiPolishAmbient = ''
    style.textContent = AMBIENT_OVERRIDES
    document.head.append(style)
    return () => { style.remove() }
  }, 'ui-polish: ambient background overrides')
  ctx.effect(() => () => { background.dispose() }, 'ui-polish: background dispose')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-polish: dictionaries')
  const t = ctx.locale.bind(NS)

  // Per-model billing index: this plugin's own messageId → model record, fed
  // by a state-only Conversation Definition over the same assistant/message
  // events the core nodes fold (the core nodes carry usage but not model
  // provenance — upstream gap). StatsFloat reads the index through its
  // injected `modelOf` face.
  const modelIndex = createModelIndex()
  ctx.inject(['conversationEvents'], (scope: ClientContext) => {
    const conversationEvents = scope.conversationEvents
    scope.effect(() => conversationEvents.register(
      modelIndexDefinition(modelIndex),
    ), 'ui-polish: model index definition')
  })

  const store = createBackgroundRowStore()
  let bound: BoundActions<typeof store> | undefined
  let revision = 0
  const sync = (): void => {
    revision += 1
    bound?.sync(background.getBackgroundImage(), revision)
  }
  ctx.effect(() => background.subscribe(sync), 'ui-polish: background row sync')
  const injected = (actions: BoundActions<typeof store>): BackgroundRowInjected => {
    bound = actions
    // Re-sync from the getter so no change is lost between registration and
    // first render (the store's revision guard drops stale duplicates).
    sync()
    return {
      setBackgroundImage: (dataUrl) => { background.setBackgroundImage(dataUrl) },
    }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'polish-background',
    order: 30,
    store,
    locale: NS,
    inject: injected,
  }, BackgroundRow))

  // Automatic-compaction threshold row: reads and writes the durable
  // ui-polish settings field the node half's per-step control consumes.
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'polish-compaction',
    order: 40,
    locale: NS,
    inject: (): CompactionRowInjected => ({
      currentRatio: host.getSnapshot().value?.compactionThresholdRatio ?? null,
      setRatio: (ratio) => {
        if (ratio === null) void host.unset(COMPACTION_RATIO_FIELD)
        else void host.set(COMPACTION_RATIO_FIELD, ratio)
      },
    }),
  }, CompactionRow))

  // Model rate card row: edit the JSON card that prices the stats float. The
  // row shares the plugin settings scope; the pricing runtime adopts and
  // validates the durable text, so a saved card survives restarts and the
  // float re-prices immediately.
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'polish-pricing',
    order: 50,
    locale: NS,
    inject: (): PricingRowInjected => ({
      currentJson: pricing.getUserJson() ?? JSON.stringify(SEED_RATE_CARD, null, 2),
      hasCustom: pricing.getUserJson() !== null,
      save: (json) => { pricing.save(json) },
      reset: () => { pricing.reset() },
    }),
  }, PricingRow))

  ctx.slots.inject('conversation.composer.dock', function* () {
    yield ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'polish-stats',
      order: 0,
      locale: NS,
      inject: (): { modelOf: ModelIndex['modelOf']; card: ReturnType<PricingRuntime['getCard']> } => ({
        modelOf: modelIndex.modelOf,
        card: pricing.getCard(),
      }),
    }, StatsFloat)
  })

  // File panel: a conversation.view tab (between the trajectory and Git tabs)
  // listing every file a settled tool call operated on, with in-place editing.
  ctx.slots.inject('conversation.view', function* () {
    yield ctx.slots.register({
      name: 'conversation.view',
      id: 'files',
      order: 15,
      locale: NS,
      label: () => t('diff.tab'),
    }, MutationDiffPanel)
    // Git panel as a conversation view tab: appears in the top tab ring right
    // after the file tab, rendered only when selected. Collapsed state and
    // fetch caching live in the component.
    yield ctx.slots.register({
      name: 'conversation.view',
      id: 'git',
      order: 20,
      locale: NS,
      label: () => t('git.tab'),
    }, GitPanel)
    // Excalidraw canvas: a full whiteboard editor tab after Git, persisting
    // scene files into the workspace directory.
    yield ctx.slots.register({
      name: 'conversation.view',
      id: 'excalidraw',
      order: 25,
      locale: NS,
      label: () => t('excalidraw.title'),
    }, ExcalidrawPanel)
  })
}
