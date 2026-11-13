/**
 * MCP servers settings tab, browser half: the live list the Host manager
 * publishes, with authorization, grant removal, and restart. The tab registers
 * into the Plugins page's `settings.plugins.tab` slot; every action runs on the
 * `mcpManager` Remote, so this package owns no server state of its own.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.plugins.tab' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the mcpManager namespace.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-mcp-manager/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager/types'
import { McpSettingsTab } from './McpSettingsTab.tsx'
import type { McpServersFailure, McpServersSnapshot, McpSettingsTabInjected } from './McpSettingsTab.tsx'
import { en, ja, es, fr, de, ru, pt, zh, type McpSettingsLocaleKey } from './locales.ts'

export type {
  McpServersFailure, McpServersSnapshot, McpSettingsTabInjected, McpSettingsTabProps,
} from './McpSettingsTab.tsx'
export type { McpSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP servers settings tab copy. */
    'settings.mcp': McpSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.mcp'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.mcpManager']

/** Unwrap one Remote result or throw the Host's error. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (result.ok) return result.value
  throw new Error(`${result.error.code}: ${result.error.message}`)
}

/** Contribute the MCP servers tab to the Settings Plugins section. */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-settings-mcp: dictionaries')

  let servers: readonly McpManagedServerView[] = []
  let failure: McpServersFailure | undefined
  const listeners = new Set<() => void>()
  const publish = (next: readonly McpManagedServerView[], error?: McpServersFailure): void => {
    servers = next
    failure = error
    for (const listener of listeners) listener()
  }
  // The manager publishes the complete list on subscription and after every
  // status or entry change, so one reconnecting stream keeps this tab current.
  const stream = ctx.remote.$stream<McpManagedServerView[]>({
    name: 'mcp server list',
    open: signal => ctx.remote.mcpManager.watch(signal),
    ended: () => new Error('mcp server list stream ended'),
    carrierFailed: () => { publish(servers, 'unavailable') },
  })
  ctx.effect(() => () => stream.dispose(), 'ui-settings-mcp: server list stream')
  void (async () => {
    for await (const frame of stream) {
      publish(frame.value)
      frame.accept()
    }
  })().catch((error: unknown) => {
    ctx.logger.warn('ui-settings-mcp: server list stream failed')
    ctx.logger.warn(error)
    publish(servers, 'failed')
  })

  const injected = (): McpSettingsTabInjected => ({
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    snapshot: (): McpServersSnapshot => ({ servers, ...failure === undefined ? {} : { failure } }),
    authorize: async (name) => {
      const url = unwrap(await ctx.remote.mcpManager.authorize(name))
      // A flow that stored tokens without a redirect has nothing to open.
      if (url !== undefined) window.open(url, '_blank', 'noopener,noreferrer')
    },
    forgetAuthorization: async (name) => { unwrap(await ctx.remote.mcpManager.forgetAuthorization(name)) },
    restart: async (name) => { unwrap(await ctx.remote.mcpManager.restart(name)) },
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'mcp',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, McpSettingsTab))
}
