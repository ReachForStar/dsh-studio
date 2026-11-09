/**
 * What the `paperReader` tab type IS: a page, not a viewer. It claims no
 * resource address, and the guide offers it as an entry box.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconDeliverDocRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from './locales.ts'

/** The tab kind this package owns. */
export const PAPER_READER_KIND = 'paperReader'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const PAPER_READER_ID = '@reachforstar/dsh-client-ui-paper-reader'

/**
 * The paper reader's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function paperReaderDefinition(t: TranslateNS<'paperReader'>): SidebarRightTabDefinition {
  return {
    id: PAPER_READER_ID,
    kind: PAPER_READER_KIND,
    priority: 'builtin',
    title: () => t('tabTitle'),
    guide: [{
      id: 'library',
      order: 40,
      title: () => t('guideTitle'),
      description: () => t('guideDescription'),
      icon: IconDeliverDocRegular,
    }],
  }
}
