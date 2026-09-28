/**
 * Invariant companion of `@reachforstar/dsh-ssh`: a registry that an external
 * document edit pushed into duplicate ids or names must fail loud when the
 * `settings/document-updated` commit signal fires.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as SshInvariant from '../src/invariant.ts'
import { SSH_SETTINGS_NAMESPACE, SshConnectionId } from '../src/index.ts'
import type { SshSettingsSection, SshStoredDefinition } from '../src/index.ts'
import { StubSshService } from './stub-service.ts'

async function setup(withSsh: boolean): Promise<{ ctx: Context; ssh: StubSshService | undefined }> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SshInvariant)
  if (withSsh) await ctx.plugin(StubSshService)
  return { ctx, ssh: ctx.get('sshSftp') as StubSshService | undefined }
}

/** One well-formed stored definition for seeding an externally edited section. */
function stored(id: string, name: string): SshStoredDefinition {
  return {
    id: SshConnectionId(id),
    name,
    host: 'h',
    port: 22,
    username: 'u',
    auth: { kind: 'password', password: 'x' },
    connectTimeoutMs: 10_000,
  }
}

/** Simulate a settings document commit reaching the invariant listener. */
function commit(ctx: Context, ns: string): void {
  ctx.emit('settings/document-updated', ns as SettingsNamespace, 1)
}

describe('ssh invariants', () => {
  it('stays silent without a live ssh service', async () => {
    const { ctx } = await setup(false)
    // A provider that is not mounted owns no ids: the check returns silently.
    expect(() => commit(ctx, SSH_SETTINGS_NAMESPACE)).not.toThrow()
  })

  it('fails an externally edited registry with duplicate connection names', async () => {
    const { ctx, ssh } = await setup(true)
    const section: SshSettingsSection = {
      connections: [stored('aaaaaaaa-0000-4000-8000-000000000001', 'dup'), stored('aaaaaaaa-0000-4000-8000-000000000002', 'dup')],
      knownHosts: {},
    }
    ssh!.seedSection(section)
    expect(() => commit(ctx, SSH_SETTINGS_NAMESPACE)).toThrow(/duplicate connection names/)
  })

  it('fails an externally edited registry with duplicate connection ids', async () => {
    const { ctx, ssh } = await setup(true)
    const section: SshSettingsSection = {
      connections: [stored('aaaaaaaa-0000-4000-8000-000000000001', 'one'), stored('aaaaaaaa-0000-4000-8000-000000000001', 'two')],
      knownHosts: {},
    }
    ssh!.seedSection(section)
    expect(() => commit(ctx, SSH_SETTINGS_NAMESPACE)).toThrow(/duplicate connection ids/)
  })

  it('revalidates the live registry on commits from other namespaces too', async () => {
    // The listener carries no namespace filter: every document commit re-checks
    // the live registry, so a healthy registry passes and a broken one still
    // fails regardless of which namespace announced the update.
    const { ctx, ssh } = await setup(true)
    expect(() => commit(ctx, 'other')).not.toThrow()
    ssh!.seedSection({
      connections: [stored('aaaaaaaa-0000-4000-8000-000000000001', 'dup'), stored('aaaaaaaa-0000-4000-8000-000000000002', 'dup')],
      knownHosts: {},
    })
    expect(() => commit(ctx, 'other')).toThrow(/duplicate connection names/)
  })

  it('accepts a well-formed externally edited registry', async () => {
    const { ctx, ssh } = await setup(true)
    ssh!.seedSection({ connections: [stored('aaaaaaaa-0000-4000-8000-000000000001', 'one')], knownHosts: {} })
    expect(() => commit(ctx, SSH_SETTINGS_NAMESPACE)).not.toThrow()
  })
})
