/** Browser side of side questions: a Session-header action and one modal. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { BtwController } from './controller.ts'
import { BtwDialog, type BtwDialogInjected } from './BtwDialog.tsx'
import { en, es, fr, de, ru, pt, ja, NS, zh, type BtwKey } from './locales.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    btw: BtwController
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    btw: BtwKey
  }
}

export const inject = ['slots', 'locale', 'contextMenus']

/**
 * Offer one side question from the Session header and mount its modal.
 * @param ctx - browser context carrying slots, locale, and the Session menu.
 */
export function apply(ctx: ClientContext): void {
  const controller = new BtwController()
  ctx.provide('btw', controller)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'btw: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.contextMenus.register({
    id: 'btw.ask',
    target: 'sessionHeader',
    order: 140,
    observe: () => [ctx.locale],
    resolve: ({ sessionId }) => [{
      id: 'ask',
      label: t('menu.ask'),
      run: () => { controller.open(sessionId) },
    }],
  }), 'btw: Header side question')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'btw.dialog',
    locale: NS,
    inject: (): BtwDialogInjected => ({
      hooks: { btw: controller.store },
      dismiss: () => { controller.close() },
    }),
  }, BtwDialog))
}

export type { BtwDialogInjected, BtwDialogProps } from './BtwDialog.tsx'
export { BtwController } from './controller.ts'
