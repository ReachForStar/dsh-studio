import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SshRemoteDefinition, SshRemoteSaveRequest } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SshConnectionsState } from './ssh-store.ts'
import { SshConnectionsStore } from './ssh-store.ts'
import css from './SshSection.module.css'

/** Registration-side face: the store handle and its snapshot seat. */
export interface SshSectionInjected {
  controller: SshConnectionsStore
  hooks: { snapshot: SnapshotStore<SshConnectionsState> }
}

/** Full component props assembled by the Settings slot renderer. */
export type SshSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.ssh'>
  & InjectFace<SshSectionInjected>

/** The editor's working copy of one connection. */
interface Draft {
  id?: string
  name: string
  host: string
  port: string
  username: string
  authKind: 'password' | 'privateKey'
  password: string
  privateKeyPath: string
  passphrase: string
  connectTimeoutMs: string
}

function emptyDraft(): Draft {
  return {
    name: '',
    host: '',
    port: '22',
    username: '',
    authKind: 'password',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    connectTimeoutMs: '10000',
  }
}

function draftOf(definition: SshRemoteDefinition): Draft {
  return {
    id: definition.id,
    name: definition.name,
    host: definition.host,
    port: String(definition.port),
    username: definition.username,
    authKind: definition.authKind,
    password: '',
    privateKeyPath: definition.privateKeyPath ?? '',
    passphrase: '',
    connectTimeoutMs: String(definition.connectTimeoutMs),
  }
}

function validateDraft(draft: Draft, t: SshSectionProps['t']): string | null {
  if (draft.name.trim().length === 0) return t('emptyName')
  if (draft.host.trim().length === 0) return t('emptyHost')
  if (draft.username.trim().length === 0) return t('emptyUsername')
  if (draft.authKind === 'password' && draft.id === undefined && draft.password.length === 0) return t('emptyPassword')
  if (draft.authKind === 'privateKey' && draft.id === undefined && draft.privateKeyPath.trim().length === 0) return t('emptyKeyPath')
  return null
}

function toRequest(draft: Draft): SshRemoteSaveRequest {
  return {
    ...draft.id !== undefined ? { id: draft.id } : {},
    name: draft.name.trim(),
    host: draft.host.trim(),
    ...draft.port.length > 0 ? { port: Number(draft.port) } : {},
    username: draft.username.trim(),
    authKind: draft.authKind,
    ...draft.authKind === 'password'
      ? { ...draft.password.length > 0 ? { password: draft.password } : {} }
      : {
        privateKeyPath: draft.privateKeyPath.trim(),
        ...draft.passphrase.length > 0 ? { passphrase: draft.passphrase } : {},
      },
    ...draft.connectTimeoutMs.length > 0 ? { connectTimeoutMs: Number(draft.connectTimeoutMs) } : {},
  }
}

/** One row's probe state. */
interface ProbeState {
  status: 'idle' | 'testing'
  message: string | null
}

/** Render the SSH connection-management page. */
export function SshSection({ controller, useSnapshot, t }: SshSectionProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [formBusy, setFormBusy] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, ProbeState>>({})

  useEffect(() => {
    void controller.load()
  }, [controller])

  const startCreate = (): void => {
    setFormError(null)
    setEditing(emptyDraft())
  }

  const startEdit = (definition: SshRemoteDefinition): void => {
    setFormError(null)
    setEditing(draftOf(definition))
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (editing === null || formBusy) return
    const problem = validateDraft(editing, t)
    if (problem !== null) {
      setFormError(problem)
      return
    }
    setFormBusy(true)
    setFormError(null)
    try {
      await controller.save(toRequest(editing))
      setEditing(null)
    } catch (error) {
      setFormError(t('saveFailed').replace('{error}', error instanceof Error ? error.message : String(error)))
    } finally {
      setFormBusy(false)
    }
  }

  const remove = async (definition: SshRemoteDefinition): Promise<void> => {
    if (confirmingId === definition.id) {
      setConfirmingId(null)
      try {
        await controller.remove(definition.id)
      } catch (error) {
        setFormError(t('deleteFailed').replace('{error}', error instanceof Error ? error.message : String(error)))
      }
      return
    }
    setConfirmingId(definition.id)
  }

  const probe = async (definition: SshRemoteDefinition): Promise<void> => {
    setProbes(current => ({ ...current, [definition.id]: { status: 'testing', message: null } }))
    const outcome = await controller.test(definition.id)
    setProbes(current => ({
      ...current,
      [definition.id]: {
        status: 'idle',
        message: outcome.ok
          ? t('testOk').replace('{ms}', String(outcome.latencyMs))
          : t('testFail').replace('{error}', outcome.error ?? ''),
      },
    }))
  }

  return (
    <div className={css.section}>
      <p className={css.description}>{t('description')}</p>
      {state.status === 'loading' ? <p className={css.status}>{t('testing')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('loadFailed')}</p>
          <button type="button" onClick={() => { void controller.load() }}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' && state.connections.length === 0 ? (
        <p className={css.status}>{t('empty')}</p>
      ) : null}
      {state.connections.length > 0 ? (
        <ul className={css.cards}>
          {state.connections.map((definition) => {
            const probeState = probes[definition.id] ?? { status: 'idle' as const, message: null }
            return (
              <li className={css.card} key={definition.id} data-ssh-connection={definition.id}>
                <div className={css.cardMain}>
                  <strong className={css.cardTitle}>{definition.name}</strong>
                  <span className={css.cardAddress}>
                    {definition.username}@{definition.host}:{definition.port}
                  </span>
                  <span className={css.cardAuth} data-auth={definition.authKind}>
                    {definition.authKind === 'password' ? t('authPassword') : t('authPrivateKey')}
                  </span>
                  <span className={css.cardSecret}>
                    {definition.authKind === 'password' && !definition.passwordSet ? t('passwordUnset') : null}
                  </span>
                </div>
                <div className={css.cardActions}>
                  {probeState.message !== null ? <span className={css.probeMessage}>{probeState.message}</span> : null}
                  <button
                    type="button"
                    className={css.action}
                    disabled={probeState.status === 'testing'}
                    onClick={() => { void probe(definition) }}
                  >
                    {probeState.status === 'testing' ? t('testing') : t('test')}
                  </button>
                  <button type="button" className={css.action} onClick={() => { startEdit(definition) }}>{t('edit')}</button>
                  <button
                    type="button"
                    className={css.action}
                    data-danger={confirmingId === definition.id ? 'true' : undefined}
                    onClick={() => { void remove(definition) }}
                  >
                    {confirmingId === definition.id ? t('deleteConfirm') : t('delete')}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
      {editing === null ? (
        <div className={css.newRow}>
          <button type="button" className={css.newButton} onClick={startCreate}>{t('new')}</button>
        </div>
      ) : (
        <form className={css.editor} onSubmit={(event) => { void submit(event) }}>
          <h3 className={css.editorTitle}>{editing.id === undefined ? t('new') : t('edit')}</h3>
          <div className={css.field}>
            <label htmlFor="ssh-name">{t('name')}</label>
            <input
              id="ssh-name"
              type="text"
              value={editing.name}
              onChange={(event) => { setEditing({ ...editing, name: event.currentTarget.value }) }}
            />
          </div>
          <div className={css.fieldRow}>
            <div className={css.field}>
              <label htmlFor="ssh-host">{t('host')}</label>
              <input
                id="ssh-host"
                type="text"
                value={editing.host}
                onChange={(event) => { setEditing({ ...editing, host: event.currentTarget.value }) }}
              />
            </div>
            <div className={css.field}>
              <label htmlFor="ssh-port">{t('port')}</label>
              <input
                id="ssh-port"
                type="number"
                min={1}
                max={65535}
                value={editing.port}
                onChange={(event) => { setEditing({ ...editing, port: event.currentTarget.value }) }}
              />
            </div>
          </div>
          <div className={css.field}>
            <label htmlFor="ssh-username">{t('username')}</label>
            <input
              id="ssh-username"
              type="text"
              autoComplete="username"
              value={editing.username}
              onChange={(event) => { setEditing({ ...editing, username: event.currentTarget.value }) }}
            />
          </div>
          <div className={css.field}>
            <label htmlFor="ssh-auth">{t('auth')}</label>
            <select
              id="ssh-auth"
              value={editing.authKind}
              onChange={(event) => {
                setEditing({ ...editing, authKind: event.currentTarget.value as 'password' | 'privateKey' })
              }}
            >
              <option value="password">{t('authPassword')}</option>
              <option value="privateKey">{t('authPrivateKey')}</option>
            </select>
          </div>
          {editing.authKind === 'password' ? (
            <div className={css.field}>
              <label htmlFor="ssh-password">{t('password')}</label>
              <input
                id="ssh-password"
                type="password"
                autoComplete="new-password"
                value={editing.password}
                placeholder={editing.id === undefined ? undefined : t('passwordHint')}
                onChange={(event) => { setEditing({ ...editing, password: event.currentTarget.value }) }}
              />
            </div>
          ) : (
            <>
              <div className={css.field}>
                <label htmlFor="ssh-key-path">{t('privateKeyPath')}</label>
                <input
                  id="ssh-key-path"
                  type="text"
                  value={editing.privateKeyPath}
                  onChange={(event) => { setEditing({ ...editing, privateKeyPath: event.currentTarget.value }) }}
                />
              </div>
              <div className={css.field}>
                <label htmlFor="ssh-passphrase">{t('passphrase')}</label>
                <input
                  id="ssh-passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={editing.passphrase}
                  onChange={(event) => { setEditing({ ...editing, passphrase: event.currentTarget.value }) }}
                />
              </div>
            </>
          )}
          <div className={css.field}>
            <label htmlFor="ssh-timeout">{t('connectTimeoutMs')}</label>
            <input
              id="ssh-timeout"
              type="number"
              min={1000}
              max={300000}
              value={editing.connectTimeoutMs}
              onChange={(event) => { setEditing({ ...editing, connectTimeoutMs: event.currentTarget.value }) }}
            />
          </div>
          {formError !== null ? <p className={css.formError} role="alert">{formError}</p> : null}
          <div className={css.editorActions}>
            <button type="submit" className={css.saveButton} disabled={formBusy}>{t('save')}</button>
            <button type="button" className={css.action} onClick={() => { setEditing(null) }}>{t('cancel')}</button>
          </div>
        </form>
      )}
    </div>
  )
}
