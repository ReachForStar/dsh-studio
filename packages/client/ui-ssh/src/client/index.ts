/**
 * SSH/SFTP connection-management page, browser half: registers the `ssh`
 * settings section over the ssh Remote gateway. Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the ssh payload vocabulary into
// this program (the assembly is the one place both planes legitimately meet).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { SshSection, type SshSectionInjected } from './SshSection.tsx'
import { SshConnectionsStore, type SshRemoteFace } from './ssh-store.ts'
import { en, zh, type SshLocaleKey } from './locales.ts'

export type { SshSectionInjected, SshSectionProps } from './SshSection.tsx'
export type { SshConnectionsState, SshRemoteFace } from './ssh-store.ts'
export type { SshLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** SSH connection-management copy. */
    'settings.ssh': SshLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.ssh'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.ssh']

/** Contribute the SSH connection-management section to Web Settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-ssh: dictionaries')

  const t = ctx.locale.bind(NS)
  const remote: SshRemoteFace = {
    list: async () => {
      const result = await ctx.remote.ssh.list()
      if (!result.ok) throw new Error(`ssh.list failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
    save: async (request) => {
      const result = await ctx.remote.ssh.save(request)
      if (!result.ok) throw new Error(`ssh.save failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
    remove: async (id) => {
      const result = await ctx.remote.ssh.delete(id)
      if (!result.ok) throw new Error(`ssh.delete failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
    test: async (id) => {
      const result = await ctx.remote.ssh.test(id)
      if (!result.ok) throw new Error(`ssh.test failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
  }
  const controller = new SshConnectionsStore(remote)
  const injected = (): SshSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'ssh',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, SshSection))
}
