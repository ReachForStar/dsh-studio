import { memo } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconGlobeOutlineRegular, LinkIconMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import type { TurnSourceEntry } from '../contract/chat-nodes.ts'
import css from './TurnSourcesNodeView.module.css'

/** Only an http(s) source reaches the DOM as a link; anything else stays plain text. */
function safeHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** The visible label: the provider title, else the hostname, else the raw URL. */
function sourceLabel(source: TurnSourceEntry): string {
  if (source.title !== undefined && source.title !== '') return source.title
  try {
    const { hostname } = new URL(source.url)
    return hostname === '' ? source.url : hostname
  } catch {
    return source.url
  }
}

/**
 * One Turn's distinct web sources, collected from its search and fetch results.
 * Collapsed by default so the reader keeps the transcript's density; opening it
 * lists the cited titles, and each row delegates navigation to the view's
 * external-link handler rather than opening a window itself.
 */
export const TurnSourcesNodeView = memo(function TurnSourcesNodeView({
  node, t, useDisclosure, openExternalLink,
}: ChatNodeViewProps<'turn-sources'>) {
  const { expanded, toggle } = useDisclosure()
  const sources = node.data.sources
  const count = t(sources.length === 1 ? 'message.sources.count.one' : 'message.sources.count.other', {
    count: sources.length,
  })
  return (
    <div className={css.root} data-turn-sources={node.data.turn} data-turn-sources-count={sources.length}>
      <button type="button" className={css.header} aria-expanded={expanded} onClick={toggle}>
        {expanded
          ? <IconChevronDownOutlineRegular className={css.chevron} />
          : <IconChevronRightOutlineRegular className={css.chevron} />}
        <IconGlobeOutlineRegular className={css.icon} />
        <span className={css.title}>{t('message.sources.title')}</span>
        <span className={css.count}>{count}</span>
      </button>
      {expanded && (
        <ul className={css.list}>
          {sources.map((source) => {
            const href = safeHref(source.url)
            const label = sourceLabel(source)
            return (
              <li key={source.url} className={css.item} data-turn-source-url={source.url}>
                {href === undefined
                  ? <span className={css.plain}>{label}</span>
                  : (
                    <a
                      className={css.link}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(event) => {
                        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                        event.preventDefault()
                        openExternalLink(href)
                      }}
                    >
                      <LinkIconMedium kind="url" href={href} className={css.siteIcon} />
                      <span className={css.label}>{label}</span>
                    </a>
                  )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
})
