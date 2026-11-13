import { useSyncExternalStore, useState, type ReactNode } from 'react'
import type { McpManagedServerStatus, McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager/types'
import { StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpSettingsLocaleKey } from './locales.ts'
import css from './McpSettingsTab.module.css'

/** Why the server list is unavailable; absent while the stream is healthy. */
export type McpServersFailure = 'unavailable' | 'failed'

/** One published view of the managed server list. */
export interface McpServersSnapshot {
  /** Latest list the Host published, in management order. */
  readonly servers: readonly McpManagedServerView[]
  /** Stream failure, when the list cannot be kept current. */
  readonly failure?: McpServersFailure
}

/** Registration-side face the tab reads and acts through. */
export interface McpSettingsTabInjected {
  /** Observe list publications. */
  subscribe: (listener: () => void) => () => void
  /** Read the current list and failure. */
  snapshot: () => McpServersSnapshot
  /** Start an interactive authorization and open its URL. */
  authorize: (name: string) => Promise<void>
  /** Remove a stored grant. */
  forgetAuthorization: (name: string) => Promise<void>
  /** Rebuild one server instance. */
  restart: (name: string) => Promise<void>
}

/** Full component props assembled by the Settings slot renderer. */
export type McpSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.mcp'>
  & InjectFace<McpSettingsTabInjected>

type Translate = McpSettingsTabProps['t']
type StatusState = McpManagedServerStatus['state']
type FailureReason = Extract<McpManagedServerStatus, { state: 'failed' }>['reason']

const STATUS_KEYS = {
  connected: 'statusConnected',
  connecting: 'statusConnecting',
  reconnecting: 'statusReconnecting',
  'waiting-credentials': 'statusWaitingCredentials',
  'waiting-authorization': 'statusWaitingAuthorization',
  failed: 'statusFailed',
  disabled: 'statusDisabled',
  closed: 'statusClosed',
} as const satisfies Record<StatusState, McpSettingsLocaleKey>

const REASON_KEYS = {
  'gave-up': 'reasonGaveUp',
  'reconnect-disabled': 'reasonReconnectDisabled',
  'unclosed-generation': 'reasonUnclosedGeneration',
  load: 'reasonLoad',
  cleanup: 'reasonCleanup',
} as const satisfies Record<FailureReason, McpSettingsLocaleKey>

const TONES = {
  connected: 'info',
  connecting: 'warning',
  reconnecting: 'warning',
  'waiting-credentials': 'warning',
  'waiting-authorization': 'warning',
  failed: 'danger',
  disabled: 'neutral',
  closed: 'neutral',
} as const satisfies Record<StatusState, TagTone>

/** Dotted states show progress; a settled row needs no dot. */
const DOT_STATES = {
  connecting: 'ongoing',
  reconnecting: 'ongoing',
  'waiting-credentials': 'ongoing',
  'waiting-authorization': 'ongoing',
} as const

/** Localized status line for one server. */
function statusText(status: McpManagedServerStatus, t: Translate): string {
  switch (status.state) {
    case 'connected': return t('statusConnected', { count: String(status.toolCount) })
    case 'connecting': return t(STATUS_KEYS.connecting)
    case 'reconnecting': return t('statusReconnecting', { attempt: String(status.attempt), max: String(status.maxAttempts) })
    case 'waiting-credentials': return t(STATUS_KEYS['waiting-credentials'])
    case 'waiting-authorization': return t(STATUS_KEYS['waiting-authorization'])
    case 'failed': return t('statusFailed', { reason: t(REASON_KEYS[status.reason]) })
    case 'disabled': return t(STATUS_KEYS.disabled)
    case 'closed': return t(STATUS_KEYS.closed)
  }
}

/** The diagnostic a row shows under its status, when the Host reported one. */
function statusDetail(status: McpManagedServerStatus): string | undefined {
  if (status.state === 'failed') return status.reason === 'cleanup' ? status.result.cleanupError : status.lastError
  if (status.state === 'waiting-credentials' || status.state === 'waiting-authorization') return status.lastError
  if (status.state === 'reconnecting') return status.lastError
  return undefined
}

/** Render the managed MCP servers with their live status and actions. */
export function McpSettingsTab(
  { t, subscribe, snapshot, authorize, forgetAuthorization, restart }: McpSettingsTabProps,
): ReactNode {
  const { servers, failure } = useSyncExternalStore(subscribe, snapshot)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ name: string; message: string } | null>(null)

  const run = (name: string, action: () => Promise<void>): void => {
    setBusy(name)
    setFailed(null)
    void action().catch((error: unknown) => {
      setFailed({ name, message: error instanceof Error ? error.message : String(error) })
    }).finally(() => { setBusy(null) })
  }

  return (
    <div className={css.section}>
      <p className={css.description}>{t('description')}</p>
      {failure === undefined ? null : (
        <p className={css.failure} role="alert">
          <StateDot state="error" />
          {failure === 'unavailable' ? t('unavailable') : t('failedToLoad')}
        </p>
      )}
      {servers.length === 0 && failure === undefined ? <p className={css.empty}>{t('empty')}</p> : null}
      <ul className={css.rows}>
        {servers.map((server) => {
          const detail = statusDetail(server.status)
          const working = busy === server.name
          return (
            <li key={server.name} className={css.row} data-mcp-server={server.name} data-state={server.status.state}>
              <div className={css.head}>
                <code className={css.name}>{server.name}</code>
                <span className={css.status}>
                  {server.status.state in DOT_STATES
                    ? <StateDot state={DOT_STATES[server.status.state as keyof typeof DOT_STATES]} />
                    : null}
                  <Tag tone={TONES[server.status.state]}>{statusText(server.status, t)}</Tag>
                </span>
              </div>
              {detail === undefined ? null : (
                <p className={css.detail}>
                  <span className={css.detailLabel}>{t('lastError')}</span>
                  <code>{detail}</code>
                </p>
              )}
              {failed?.name === server.name ? (
                <p className={css.actionError} role="alert">{t('actionFailed', { message: failed.message })}</p>
              ) : null}
              {server.status.state === 'disabled' ? null : (
                <div className={css.actions}>
                  {server.oauth ? (
                    <button
                      type="button"
                      className={css.primary}
                      disabled={working}
                      onClick={() => { run(server.name, () => authorize(server.name)) }}
                    >
                      {working ? t('working') : t('authorize')}
                    </button>
                  ) : null}
                  {server.oauth ? (
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => { run(server.name, () => forgetAuthorization(server.name)) }}
                    >
                      {t('clearAuthorization')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => { run(server.name, () => restart(server.name)) }}
                  >
                    {t('restart')}
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
