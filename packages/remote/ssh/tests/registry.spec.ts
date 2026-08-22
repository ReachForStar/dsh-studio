/**
 * Registry behavior of the `ctx.ssh` Service Definition: save/get/list/remove,
 * name uniqueness, secret-free views, the compose-able test probe, and the
 * settings-document persistence boundary — all through the real settings seam
 * with an in-memory provider.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import { SSH_SETTINGS_NAMESPACE, SshConnectionId } from '../src/index.ts'
import { StubSshService } from './stub-service.ts'

async function setup(): Promise<{ ctx: Context; ssh: StubSshService; settings: MemorySettings }> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(StubSshService)
  return { ctx, ssh: ctx.ssh as StubSshService, settings: ctx.settings as MemorySettings }
}

function saveInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'prod',
    host: 'example.com',
    username: 'deploy',
    auth: { kind: 'password', password: 's3cret' },
    ...overrides,
  }
}

describe('ssh definition registry', () => {
  it('creates, lists, and looks up definitions by id and by name', async () => {
    const { ssh } = await setup()
    const created = await ssh.save(saveInput())
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(ssh.list()).toEqual([created])
    expect(ssh.get(created.id)).toEqual(created)
    expect(ssh.get('prod')).toEqual(created)
    expect(ssh.get('missing')).toBeUndefined()
  })

  it('normalizes defaults and rejects invalid inputs at the save boundary', async () => {
    const { ssh } = await setup()
    const created = await ssh.save(saveInput({ port: 2222, connectTimeoutMs: 2000 }))
    expect(created.port).toBe(2222)
    expect(created.connectTimeoutMs).toBe(2000)

    const defaults = await ssh.save(saveInput({ name: 'defaults' }))
    expect(defaults.port).toBe(22)
    expect(defaults.connectTimeoutMs).toBe(10_000)

    const cases: Array<[string, unknown]> = [
      ['empty name', saveInput({ name: '  ' })],
      ['empty host', saveInput({ host: '' })],
      ['empty username', saveInput({ username: '' })],
      ['bad port', saveInput({ port: 0 })],
      ['bad port type', saveInput({ port: '22' })],
      ['bad timeout', saveInput({ connectTimeoutMs: 50 })],
      ['missing auth', saveInput({ auth: {} })],
      ['unknown auth kind', saveInput({ auth: { kind: 'token', password: 'x' } })],
      ['empty password', saveInput({ auth: { kind: 'password', password: '' } })],
      ['empty private key path', saveInput({ auth: { kind: 'privateKey', privateKeyPath: ' ' } })],
      ['name not a string', saveInput({ name: 123 })],
      ['auth not an object', saveInput({ auth: 'token' })],
      ['auth null', saveInput({ auth: null })],
      ['password not a string', saveInput({ auth: { kind: 'password', password: 123 } })],
      ['private key path not a string', saveInput({ auth: { kind: 'privateKey', privateKeyPath: 123 } })],
      ['passphrase not a string', saveInput({ auth: { kind: 'privateKey', privateKeyPath: '/k', passphrase: 123 } })],
      ['fingerprint not a string', saveInput({ hostKeyFingerprint: 123 })],
      ['fingerprint malformed', saveInput({ hostKeyFingerprint: 'not-a-fingerprint' })],
      ['id not a string', saveInput({ id: 123 })],
      ['non-object input', 'nope'],
    ]
    for (const [label, input] of cases) {
      await expect(ssh.save(input)).rejects.toMatchObject({ code: 'SSH_INVALID_DEFINITION' })
      void label
    }
  })

  it('keeps stored secrets on updates that omit them (write-only semantics)', async () => {
    const { ssh } = await setup()
    const created = await ssh.save(saveInput())
    const updated = await ssh.save(saveInput({ id: created.id, username: 'root', auth: { kind: 'password' } }))
    expect(updated.username).toBe('root')
    expect(updated.auth).toEqual({ kind: 'password', password: 's3cret' })

    const keyed = await ssh.save(saveInput({
      name: 'keyed',
      auth: { kind: 'privateKey', privateKeyPath: '/k', passphrase: 'pa' },
    }))
    const keyUpdated = await ssh.save(saveInput({
      name: 'keyed',
      id: keyed.id,
      auth: { kind: 'privateKey' },
    }))
    expect(keyUpdated.auth).toEqual({ kind: 'privateKey', privateKeyPath: '/k', passphrase: 'pa' })

    // An update of a key without a passphrase keeps the absence.
    const plainKey = await ssh.save(saveInput({
      name: 'plain-key',
      auth: { kind: 'privateKey', privateKeyPath: '/k2' },
    }))
    const plainUpdated = await ssh.save(saveInput({
      name: 'plain-key',
      id: plainKey.id,
      auth: { kind: 'privateKey', privateKeyPath: '/k3' },
    }))
    expect(plainUpdated.auth).toEqual({ kind: 'privateKey', privateKeyPath: '/k3' })

    // A kind switch replaces the auth wholesale and requires complete fields.
    const switched = await ssh.save(saveInput({
      name: 'keyed',
      id: keyed.id,
      auth: { kind: 'password', password: 'new-pass' },
    }))
    expect(switched.auth).toEqual({ kind: 'password', password: 'new-pass' })
  })

  it('rejects duplicate names and updates an existing id instead', async () => {
    const { ssh } = await setup()
    const first = await ssh.save(saveInput())
    await expect(ssh.save(saveInput({ username: 'other' }))).rejects.toMatchObject({
      code: 'SSH_NAME_EXISTS',
    })
    // Name change with the existing id succeeds; a fresh id with an existing
    // name does not.
    const renamed = await ssh.save(saveInput({ id: first.id, name: 'prod-2' }))
    expect(renamed.name).toBe('prod-2')
    await expect(ssh.save(saveInput({ id: SshConnectionId('00000000-0000-4000-8000-000000000000'), name: 'prod-2' })))
      .rejects.toMatchObject({ code: 'SSH_NAME_EXISTS' })
    expect(ssh.list()).toHaveLength(1)
    expect(ssh.list()[0]).toEqual(renamed)
  })

  it('rejects updating an id that does not exist', async () => {
    const { ssh } = await setup()
    await expect(ssh.save(saveInput({ id: SshConnectionId('00000000-0000-4000-8000-000000000000') })))
      .rejects.toMatchObject({ code: 'SSH_NOT_FOUND' })
  })

  it('remembers host keys and short-circuits an identical re-record', async () => {
    const { ssh } = await setup()
    expect(ssh.knownHostFingerprint('box.example:22')).toBeUndefined()
    await ssh.rememberHostKey('box.example:22', 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
    expect(ssh.knownHostFingerprint('box.example:22')).toBe('SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
    const persisted = ssh.list().length
    await ssh.rememberHostKey('box.example:22', 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
    expect(ssh.list().length).toBe(persisted)
  })

  it('removes by id and by name, reporting whether anything matched', async () => {
    const { ssh } = await setup()
    const first = await ssh.save(saveInput())
    const second = await ssh.save(saveInput({ name: 'staging' }))
    expect(await ssh.remove('nope')).toBe(false)
    expect(await ssh.remove(first.id)).toBe(true)
    expect(await ssh.remove('staging')).toBe(true)
    expect(ssh.list()).toEqual([])
    expect(await ssh.remove(first.id)).toBe(false)
    void second
  })

  it('persists definitions in the settings document across service reloads', async () => {
    const { ctx, settings, ssh } = await setup()
    const created = await ssh.save(saveInput({ name: 'persisted' }))
    const raw = settings.doc[SSH_SETTINGS_NAMESPACE] as { connections: unknown[] }
    expect(raw.connections).toEqual([created])
    expect(settings.persisted.at(-1)).toMatchObject({ ns: SSH_SETTINGS_NAMESPACE })

    // A second context seeded with the same document sees the saved definition.
    const reloadedCtx = new Context()
    await reloadedCtx.plugin(MemorySettings, { doc: { [SSH_SETTINGS_NAMESPACE]: raw } })
    await reloadedCtx.plugin(StubSshService)
    expect(reloadedCtx.ssh.list()).toEqual([created])
    await reloadedCtx.fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('projects secret-free views and resolves refs through the service', async () => {
    const { ssh } = await setup()
    const passwordDef = await ssh.save(saveInput())
    expect(ssh.toView(passwordDef)).toEqual({
      id: passwordDef.id,
      name: 'prod',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      auth: { kind: 'password', passwordSet: true },
      connectTimeoutMs: 10_000,
    })
    const keyDef = await ssh.save(saveInput({
      name: 'keybox',
      auth: { kind: 'privateKey', privateKeyPath: '/home/me/.ssh/id_ed25519', passphrase: 'pa' },
    }))
    expect(ssh.toView(keyDef).auth).toEqual({
      kind: 'privateKey',
      privateKeyPath: '/home/me/.ssh/id_ed25519',
      passphraseSet: true,
    })
    const bare = await ssh.save(saveInput({
      name: 'bare-key',
      auth: { kind: 'privateKey', privateKeyPath: '/home/me/.ssh/id_ed25519' },
    }))
    expect(ssh.toView(bare).auth).toEqual({
      kind: 'privateKey',
      privateKeyPath: '/home/me/.ssh/id_ed25519',
      passphraseSet: false,
    })
    const pinned = await ssh.save(saveInput({
      name: 'pinned',
      hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    }))
    expect(ssh.toView(pinned).hostKeyFingerprint).toBe('SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
    expect(ssh.resolve('prod')).toEqual(passwordDef)
    expect(() => ssh.resolve('ghost')).toThrow(/not defined/)
  })

  it('tests a reachable definition and fails loud on an unreachable one', async () => {
    const { ssh } = await setup()
    const created = await ssh.save(saveInput())
    const outcome = await ssh.test('prod')
    expect(outcome.ok).toBe(true)
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0)
    expect(ssh.connected).toBeUndefined() // the probe closed the shared handle

    ssh.connectResult = { exitCode: 1, timedOut: false, aborted: false }
    await expect(ssh.test(created.id)).rejects.toMatchObject({ code: 'SSH_CONNECT_FAILED' })
    await expect(ssh.test('ghost')).rejects.toMatchObject({ code: 'SSH_NOT_FOUND' })
  })

  it('fails loud when the registry is used after its fiber disposed', async () => {
    const { ctx, ssh } = await setup()
    await ssh.save(saveInput())
    await ctx.fiber.dispose()
    await expect(ssh.save(saveInput({ name: 'late' }))).rejects.toThrow(/not ready/)
    // The registration was withdrawn with the fiber: the service reads the
    // empty section until a fresh registration owns the namespace.
    expect(ssh.list()).toEqual([])
  })

  it('releases the settings namespace when the service fiber disposes (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const fiber = await ctx.plugin(StubSshService)
    await ctx.ssh.save(saveInput())
    await fiber.dispose()
    expect(ctx.get('ssh')).toBeUndefined()
    // Re-registration succeeds, proving the namespace registration was removed.
    await ctx.plugin(StubSshService)
    await expect(ctx.ssh.save(saveInput({ name: 'again' }))).resolves.toMatchObject({ name: 'again' })
    await ctx.fiber.dispose()
  })
})
