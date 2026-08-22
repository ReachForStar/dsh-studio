/**
 * Gateway behavior over the real registry: secret-free list/save/remove and
 * the never-throwing probe, plus the typert namespace/method shape the
 * browser bundle consumes.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import { StubSshService } from '../../../remote/ssh/tests/stub-service.ts'
import SshGateway, { toRemoteDefinition, toSaveInput, validateSaveRequest } from '../src/index.ts'
import type { SshRemoteSaveRequest } from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<{ ctx: Context; gateway: SshGateway; ssh: StubSshService }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(StubSshService)
  await ctx.plugin(SshGateway)
  const gateway = ctx.get('sshGateway') as SshGateway
  return { ctx, gateway, ssh: ctx.ssh as StubSshService }
}

describe('SshGateway', () => {
  it('publishes four direct methods under the ssh wire namespace', async () => {
    const { gateway } = await harness()
    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'sshGateway',
      namespace: 'ssh',
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'save', invocation: { kind: 'direct' } },
      { method: 'delete', invocation: { kind: 'direct' } },
      { method: 'test', invocation: { kind: 'direct' } },
    ])
  })

  it('lists, saves, and removes definitions with secrets never crossing the wire', async () => {
    const { gateway } = await harness()
    expect(gateway.list()).toEqual({ connections: [] })

    const saved = await gateway.save({
      name: 'web-box',
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      authKind: 'password',
      password: 'hunter2',
      connectTimeoutMs: 5000,
    })
    expect(saved).toEqual({
      id: saved.id,
      name: 'web-box',
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      authKind: 'password',
      passwordSet: true,
      privateKeyPath: null,
      passphraseSet: false,
      connectTimeoutMs: 5000,
    })
    expect(JSON.stringify(gateway.list())).not.toContain('hunter2')

    // An update omitting the password keeps the stored secret.
    const updated = await gateway.save({
      id: saved.id,
      name: 'web-box',
      host: 'example.com',
      username: 'root',
      authKind: 'password',
    })
    expect(updated.username).toBe('root')
    expect(updated.passwordSet).toBe(true)
    const raw = gateway.list().connections[0]!
    expect(raw.id).toBe(saved.id)

    expect(await gateway.delete(saved.id)).toEqual({ removed: true })
    expect(await gateway.delete(saved.id)).toEqual({ removed: false })
    expect(gateway.list()).toEqual({ connections: [] })
  })

  it('saves private-key definitions with write-only passphrases', async () => {
    const { gateway } = await harness()
    const saved = await gateway.save({
      name: 'key-box',
      host: 'h',
      username: 'u',
      authKind: 'privateKey',
      privateKeyPath: '/keys/id_ed25519',
      passphrase: 'pa',
    })
    expect(saved).toMatchObject({
      authKind: 'privateKey',
      privateKeyPath: '/keys/id_ed25519',
      passphraseSet: true,
    })
  })

  it('rejects malformed wire payloads with descriptive errors', async () => {
    const { gateway } = await harness()
    const cases: unknown[] = [
      null,
      { name: '', host: 'h', username: 'u', authKind: 'password' },
      { name: 'n', host: 'h', username: 'u', authKind: 'token' },
      { name: 'n', host: 'h', username: 'u', authKind: 'password', password: '' },
      { name: 'n', host: 'h', username: 'u', authKind: 'privateKey' },
      { name: 'n', host: 'h', username: 'u', authKind: 'password', port: '22' },
    ]
    for (const payload of cases) {
      await expect(gateway.save(payload as SshRemoteSaveRequest)).rejects.toThrow(/ssh save:/)
    }
    await expect(gateway.delete('')).rejects.toThrow(/non-empty/)
  })

  it('returns the probe outcome as a result, never an RPC error', async () => {
    const { gateway, ssh } = await harness()
    await gateway.save({
      name: 'box', host: 'h', username: 'u', authKind: 'password', password: 'x',
    })
    const ok = await gateway.test('box')
    expect(ok).toMatchObject({ ok: true })
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0)

    ssh.connectResult = { exitCode: 1, timedOut: false, aborted: false }
    expect(await gateway.test('box')).toMatchObject({ ok: false })
    expect(await gateway.test('')).toMatchObject({ ok: false })
    expect(await gateway.test('ghost')).toMatchObject({ ok: false })

    ssh.connectResult = { exitCode: 0, timedOut: false, aborted: false }
    ssh.connectError = new Error('plain boom')
    expect(await gateway.test('box')).toMatchObject({ ok: false, error: 'plain boom' })
    ssh.connectError = 'raw value'
    expect(await gateway.test('box')).toMatchObject({ ok: false, error: 'raw value' })
  })

  it('validates payloads and translates requests/definitions at the boundary', () => {
    expect(() => validateSaveRequest('nope')).toThrow(/must be an object/)
    expect(() => validateSaveRequest({ authKind: 'password' })).toThrow(/ssh save: name/)
    const validated = validateSaveRequest({
      name: 'n', host: 'h', username: 'u', authKind: 'password', password: 'x', port: 22,
    })
    expect(validated).toEqual({ name: 'n', host: 'h', username: 'u', authKind: 'password', password: 'x', port: 22 })
    expect(toSaveInput(validated)).toEqual({
      name: 'n', host: 'h', username: 'u',
      auth: { kind: 'password', password: 'x' }, port: 22,
    })

    const keyRequest = validateSaveRequest({
      name: 'k', host: 'h', username: 'u', authKind: 'privateKey', privateKeyPath: '/k', passphrase: 'p',
    })
    expect(toSaveInput(keyRequest)).toEqual({
      name: 'k', host: 'h', username: 'u',
      auth: { kind: 'privateKey', privateKeyPath: '/k', passphrase: 'p' },
    })
    const bareKey = validateSaveRequest({
      name: 'k', host: 'h', username: 'u', authKind: 'privateKey', privateKeyPath: '/k',
    })
    expect(toSaveInput(bareKey)).toEqual({
      name: 'k', host: 'h', username: 'u',
      auth: { kind: 'privateKey', privateKeyPath: '/k' },
    })
    // Direct calls may omit key fields entirely (write-only semantics).
    expect(toSaveInput({ name: 'k', host: 'h', username: 'u', authKind: 'privateKey' })).toEqual({
      name: 'k', host: 'h', username: 'u',
      auth: { kind: 'privateKey' },
    })
    expect(() => validateSaveRequest({
      name: 'k', host: 'h', username: 'u', authKind: 'password', id: '',
    })).toThrow(/must be non-empty/)
    expect(() => validateSaveRequest({
      name: 'k', host: 'h', username: 'u', authKind: 'password', id: 123,
    })).toThrow(/must be a string/)
    expect(() => validateSaveRequest({
      name: 'k', host: 'h', username: 'u', authKind: 'password', passphrase: 123,
    })).toThrow(/must be a string/)
    const noSecret = validateSaveRequest({ name: 'k', host: 'h', username: 'u', authKind: 'password' })
    expect(toSaveInput(noSecret)).toEqual({
      name: 'k', host: 'h', username: 'u',
      auth: { kind: 'password' },
    })

    expect(toRemoteDefinition({
      id: 'id-1' as never,
      name: 'n', host: 'h', port: 22, username: 'u',
      auth: { kind: 'password', password: 'x' },
      connectTimeoutMs: 10_000,
    })).toEqual({
      id: 'id-1', name: 'n', host: 'h', port: 22, username: 'u',
      authKind: 'password', passwordSet: true, privateKeyPath: null, passphraseSet: false,
      connectTimeoutMs: 10_000,
    })
    expect(toRemoteDefinition({
      id: 'id-2' as never,
      name: 'k', host: 'h', port: 22, username: 'u',
      auth: { kind: 'privateKey', privateKeyPath: '/k' },
      connectTimeoutMs: 10_000,
    })).toEqual({
      id: 'id-2', name: 'k', host: 'h', port: 22, username: 'u',
      authKind: 'privateKey', passwordSet: false, privateKeyPath: '/k', passphraseSet: false,
      connectTimeoutMs: 10_000,
    })
  })
})
