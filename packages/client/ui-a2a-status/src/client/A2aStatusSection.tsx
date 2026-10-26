import { useEffect, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { A2aStatusState } from './a2a-status-store.ts'
import { A2aStatusStore } from './a2a-status-store.ts'
import css from './A2aStatusSection.module.css'

/** 注册侧注入面：store 句柄和快照席位。 */
export interface A2aStatusSectionInjected {
  controller: A2aStatusStore
  hooks: { snapshot: SnapshotStore<A2aStatusState> }
}

/** 组件完整 props。 */
export type A2aStatusSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.a2aStatus'>
  & InjectFace<A2aStatusSectionInjected>

/** 渲染 a2a 服务状态指示器。 */
export function A2aStatusSection({ controller, useSnapshot, t }: A2aStatusSectionProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)

  useEffect(() => {
    void controller.load()
  }, [controller])

  // 失败类别来自 Host，文案取自本地字典：同一快照在不同语言下都能正确呈现。
  const failureText = state.kafkaFailure === 'no-runtime' ? t('kafkaNoRuntime')
    : state.kafkaFailure === 'start-failed' ? t('kafkaStartFailed')
      : state.kafkaFailure === 'not-listening' ? t('kafkaNotListening')
        : null

  return (
    <div className={css.section}>
      <p className={css.description}>{t('description')}</p>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('loadFailed')}</p>
          <button type="button" onClick={() => { void controller.load() }}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <dl className={css.grid}>
          <dt>{t('hostStatus')}</dt>
          <dd data-host-running={state.hostRunning}>
            {state.hostRunning ? t('hostRunning').replace('{port}', String(state.hostPort)) : t('hostStopped')}
          </dd>
          <dt>{t('kafkaStatus')}</dt>
          <dd data-kafka-phase={state.kafkaPhase}>
            {state.kafkaPhase === 'starting' ? t('kafkaStarting')
              : state.kafkaPhase === 'ready' ? t('kafkaReady')
                : t('kafkaUnavailable')}
          </dd>
        </dl>
      ) : null}
      {state.status === 'ready' && state.kafkaPhase === 'unavailable' ? (
        <div className={css.diagnosis}>
          {failureText === null ? null : <p className={css.reason}>{failureText}</p>}
          <p className={css.brokers}>{t('kafkaBrokers')}: {state.kafkaBrokers.join(', ')}</p>
          {state.kafkaDiagnostic === '' ? null : (
            <p className={css.diagnostic}>{t('kafkaDiagnostic')}: {state.kafkaDiagnostic}</p>
          )}
        </div>
      ) : null}
    </div>
  )
}
