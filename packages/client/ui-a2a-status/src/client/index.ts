/**
 * a2a 服务状态指示器，浏览器半：注册设置页状态指示器，并通过
 * ctx.provide('a2aStatus') 暴露 A2A 主机和 Kafka 的查询状态。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@reachforstar/dsh-a2a-status/remote'
import { A2aStatusSection, type A2aStatusSectionInjected } from './A2aStatusSection.tsx'
import { A2aStatusStore, type A2aStatusRemoteFace } from './a2a-status-store.ts'
import { en, zh, type A2aStatusLocaleKey } from './locales.ts'

export type { A2aStatusSectionInjected, A2aStatusSectionProps } from './A2aStatusSection.tsx'
export type { A2aStatusState, A2aStatusRemoteFace } from './a2a-status-store.ts'
export type { A2aStatusStore } from './a2a-status-store.ts'
export type { A2aStatusLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** a2a 服务状态指示器文案。 */
    'settings.a2aStatus': A2aStatusLocaleKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** a2a 服务状态 store；ui-a2a-status 未加载时为 undefined。 */
    a2aStatus: A2aStatusStore
  }
}

/** 文案命名空间。 */
export const NS = 'settings.a2aStatus'

/** 所需服务：slots/locale/remote 及 a2a namespace。 */
export const inject = ['slots', 'locale', 'remote', 'remote.a2a']

/** 注册 a2a 服务状态指示器并暴露状态 store。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-a2a-status: dictionaries')

  const t = ctx.locale.bind(NS)
  const remote: A2aStatusRemoteFace = {
    status: async () => {
      const result = await ctx.remote.a2a.status()
      if (!result.ok) throw new Error(`a2a.status failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
  }
  const controller = new A2aStatusStore(remote)

  ctx.effect(() => {
    const disposeProvide = ctx.provide('a2aStatus', controller)
    return async () => {
      disposeProvide()
      controller.dispose()
    }
  }, 'ui-a2a-status: provide a2aStatus store')

  const injected = (): A2aStatusSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'a2a-status',
    order: 35,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, A2aStatusSection))
}
