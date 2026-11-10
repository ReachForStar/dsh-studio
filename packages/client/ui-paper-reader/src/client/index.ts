/**
 * Browser half: register `paperReader` as a right-Sidebar tab type.
 *
 * The type reaches the Sidebar through its public path only: the definition
 * into `ctx.sidebarRightTabs`, and the body into the keyed
 * `sidebar.right.pane.tab` seat under the definition's `id`. The body reads the
 * Session's standard `inputActions` seat to fill the composer draft.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PAPER_READER_ID, paperReaderDefinition } from './definition.ts'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'
import { PaperReaderTab } from './PaperReader.tsx'

export type { PaperReaderLocaleKey } from './locales.ts'
export type { PaperReaderTabProps } from './PaperReader.tsx'

/** This package's copy namespace. */
const NS = 'paperReader'

/** Required browser services: the tab registry, its seat, and copy. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Client plugin body: register the type, its dictionaries, and its page.
 * @param ctx - client root context carrying the registry and the slots.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-paper-reader: dictionaries')
  ctx.effect(() => ctx.sidebarRightTabs.register(paperReaderDefinition(t)), 'ui-paper-reader: paper type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab', key: PAPER_READER_ID, locale: NS,
      // The page picks its initial translation language from the interface language.
      inject: () => ({ hooks: { language: ctx.locale } }),
    },
    PaperReaderTab,
  )), 'ui-paper-reader: paper body')
}
