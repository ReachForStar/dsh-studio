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
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings scope Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ui-settings-general SlotMap merge (the settings.general.item entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the composer.dock entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the slot registry Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the SSH Remote methods and forwarded PTY event declarations.
import type {} from '@reachforstar/dsh-host-ssh-remotes/remote'
import type {} from '@reachforstar/dsh-host-ssh-remotes/types'
import { BACKGROUND_SETTINGS_NAMESPACE, COMPACTION_RATIO_FIELD, type PolishSettings } from '../background-settings.ts'
import { BackgroundRuntime } from './background-runtime.ts'
import { BackgroundRow, type BackgroundRowInjected } from './BackgroundRow.tsx'
import { CompactionRow, type CompactionRowInjected } from './CompactionRow.tsx'
import { PricingRow, type PricingRowInjected } from './PricingRow.tsx'
import { createBackgroundRowStore, createCompactionRowStore, createPricingRowStore } from './settings-store.ts'
import { PricingRuntime } from './pricing-store.ts'
import { SEED_RATE_CARD } from './cost.ts'
import { StatsFloat } from './StatsFloat.tsx'
import { GitPanel } from './GitPanel.tsx'
import { ExcalidrawPanel } from './ExcalidrawPanel.tsx'
import { SshPanel, type SshPanelInjected, type SshPanelRpcResult } from './SshPanel.tsx'
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
export const inject = ['slots', 'locale', 'settingsScope', 'remote', 'remote.ssh']

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
  // ui-polish settings field the node half's per-step control consumes. A
  // store mirrors the adopted ratio so the controlled select follows a change
  // (the row never re-renders from a one-shot inject otherwise).
  const compactionStore = createCompactionRowStore()
  let compactionBound: BoundActions<typeof compactionStore> | undefined
  let compactionRevision = 0
  let compactionRatio: number | null = host.getSnapshot().value?.compactionThresholdRatio ?? null
  const syncCompaction = (): void => {
    compactionRevision += 1
    compactionBound?.sync(compactionRatio, compactionRevision)
  }
  const adoptCompaction = (): void => {
    compactionRatio = host.getSnapshot().value?.compactionThresholdRatio ?? null
    syncCompaction()
  }
  ctx.effect(() => host.subscribe(adoptCompaction), 'ui-polish: compaction row adopt')
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'polish-compaction',
    order: 40,
    store: compactionStore,
    locale: NS,
    inject: (actions: BoundActions<typeof compactionStore>): CompactionRowInjected => {
      compactionBound = actions
      syncCompaction()
      return {
        setRatio: (ratio) => {
          compactionRatio = ratio
          if (ratio === null) void host.unset(COMPACTION_RATIO_FIELD)
          else void host.set(COMPACTION_RATIO_FIELD, ratio)
          syncCompaction()
        },
      }
    },
  }, CompactionRow))

  // Model rate card row: edit the JSON card that prices the stats float. The
  // row shares the plugin settings scope; the pricing runtime adopts and
  // validates the durable text, so a saved card survives restarts and the
  // float re-prices immediately. A store mirrors the durable card text and
  // whether a user card is set so the reset gate follows a change.
  const pricingStore = createPricingRowStore()
  let pricingBound: BoundActions<typeof pricingStore> | undefined
  let pricingRevision = 0
  const syncPricing = (): void => {
    pricingRevision += 1
    const json = pricing.getUserJson()
    pricingBound?.sync(json ?? JSON.stringify(SEED_RATE_CARD, null, 2), json !== null, pricingRevision)
  }
  ctx.effect(() => host.subscribe(syncPricing), 'ui-polish: pricing row adopt')
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'polish-pricing',
    order: 50,
    store: pricingStore,
    locale: NS,
    inject: (actions: BoundActions<typeof pricingStore>): PricingRowInjected => {
      pricingBound = actions
      syncPricing()
      return {
        save: (json) => { pricing.save(json) },
        reset: () => { pricing.reset() },
      }
    },
  }, PricingRow))

  ctx.slots.inject('conversation.composer.dock', function* () {
    yield ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'polish-stats',
      order: 0,
      locale: NS,
      inject: (): { card: ReturnType<PricingRuntime['getCard']> } => ({
        card: pricing.getCard(),
      }),
    }, StatsFloat)
  })

  // File panel: a conversation.view tab (between the trajectory and Git tabs)
  // listing every file a settled tool call operated on, with in-place editing.
  const sshRpc = async (
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SshPanelRpcResult> => {
    const result = method === 'ssh.list'
      ? await ctx.remote.ssh.list()
      : method === 'ssh.exec'
        ? await ctx.remote.ssh.exec(payload as never, signal)
        : method === 'ssh.pty.open'
          ? await ctx.remote.ssh.ptyOpen(payload as never, signal)
          : method === 'ssh.pty.attach'
            ? await ctx.remote.ssh.ptyAttach(payload as never)
            : method === 'ssh.pty.write'
              ? await ctx.remote.ssh.ptyWrite(payload as never)
              : method === 'ssh.pty.resize'
                ? await ctx.remote.ssh.ptyResize(payload as never)
                : method === 'ssh.pty.close'
                  ? await ctx.remote.ssh.ptyClose(payload as never)
                  : method === 'ssh.sftp.list'
                    ? await ctx.remote.ssh.sftpList(payload as never, signal)
                    : method === 'ssh.sftp.mkdir'
                      ? await ctx.remote.ssh.sftpMkdir(payload as never, signal)
                      : method === 'ssh.sftp.remove'
                        ? await ctx.remote.ssh.sftpRemove(payload as never, signal)
                        : method === 'ssh.sftp.rename'
                          ? await ctx.remote.ssh.sftpRename(payload as never, signal)
                          : undefined
    if (result === undefined) throw new Error(`SSH 面板不支持 Remote 方法 ${method}`)
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, error: { message: `${result.error.code}: ${result.error.message}` } }
  }

  const subscribeSshFrames = (
    onFrame: Parameters<SshPanelInjected['subscribeHostFrames']>[0],
    onDrop: Parameters<SshPanelInjected['subscribeHostFrames']>[1],
  ): (() => void) => {
    const offOutput = ctx.remote.$on('ssh/pty/output', (event) => {
      onFrame({ type: 'ssh/pty/output', ptyId: event.ptyId, data: event.data })
    })
    const offExit = ctx.remote.$on('ssh/pty/exit', (event) => {
      onDrop(event.ptyId)
    })
    return () => {
      offOutput()
      offExit()
    }
  }

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
    // SSH/SFTP: interactive PTY terminal + streaming file manager.
    yield ctx.slots.register({
      name: 'conversation.view',
      id: 'ssh',
      order: 30,
      locale: NS,
      label: () => t('ssh.title'),
      inject: (): SshPanelInjected => ({
        rpc: sshRpc,
        subscribeHostFrames: subscribeSshFrames,
      }),
    }, SshPanel)
  })
}
