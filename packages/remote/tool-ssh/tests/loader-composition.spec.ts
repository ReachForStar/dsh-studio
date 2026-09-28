/**
 * Real-composition guard for the SSH tool family: a test-only profile boots
 * the actual Settings service and ConfigEditor, the real ssh2-backed provider,
 * and the tool plugin through the Loader, then the guarded executor drives a
 * save → exec → download journey against a real in-process SSH server. The
 * save persists through the real settings seam into the profile patch file.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSshService from '@reachforstar/dsh-ssh-local'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import * as ToolSsh from '../src/index.ts'
import { TEST_SSH_PASSWORD, TEST_SSH_USERNAME, TestSshServer } from '../../ssh-local/tests/test-server.ts'

let root: string | undefined
let context: Context | undefined
let server: TestSshServer | undefined
let localRoot: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await server?.stop()
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  if (localRoot !== undefined) await rm(localRoot, { recursive: true, force: true })
  localRoot = undefined
})

describe('ssh tools through a real Loader composition', () => {
  it('boots from a profile and completes a save → exec → download journey', async () => {
    server = await TestSshServer.start()
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-ssh-loader-'))

    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: tools',
      "  name: '@deepseek-ai/dsh-tools'",
      '- id: system-prompt',
      "  name: '@deepseek-ai/dsh-system-prompt'",
      '- id: ssh-local',
      "  name: '@reachforstar/dsh-ssh-local'",
      '  config:',
      '    defaultExecTimeoutMs: 60000',
      '    outputMaxBytes: 65536',
      '- id: tool-ssh',
      "  name: '@reachforstar/dsh-tool-ssh'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@reachforstar/dsh-ssh-local', LocalSshService],
      ['@reachforstar/dsh-tool-ssh', ToolSsh],
    ])
    const internal: ModuleLoaderV2 = {
      version: 'v2',
      loadCache: new Map(),
      import: (specifier: string) => {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return Promise.resolve(modules.get(specifier))
      },
      register(): never { throw new Error('unexpected module hook registration') },
      getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
      resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
      load(): never { throw new Error('unexpected module load') },
    }
    ctx.loader.internal = internal
    const patchPath = await profileComposition(ctx, root, configPath)

    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('ssh_exec')

    const execute = (name: string, args: Record<string, unknown>) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`loader-${name}`),
      name,
      arguments: args,
    })
    const textOf = (result: { content: { type: string; text?: string }[] }): string =>
      result.content.filter(block => block.type === 'text').map(block => block.text).join('')

    const saved = await execute('ssh_connect', {
      name: 'loader-box',
      host: '127.0.0.1',
      port: server.port,
      username: TEST_SSH_USERNAME,
      auth: 'password',
      password: TEST_SSH_PASSWORD,
    })
    expect(saved.isError).toBe(false)

    // The save went through the real Settings service into the profile patch.
    const patch = await readFile(patchPath, 'utf8')
    expect(patch).toContain('loader-box')

    const ran = await execute('ssh_exec', { connection: 'loader-box', command: 'echo composed' })
    expect(textOf(ran)).toContain('composed')
    expect(textOf(ran)).toContain('[exit code: 0]')

    localRoot = await mkdtemp(join(tmpdir(), 'dsh-tool-ssh-loader-'))
    const source = join(localRoot, 'src.txt')
    await writeFile(source, 'loader payload')
    const written = await execute('sftp_write', {
      connection: 'loader-box', local_path: source, remote_path: 'composed.txt',
    })
    expect(written.isError).toBe(false)

    const target = join(localRoot, 'down.txt')
    const read = await execute('sftp_read', {
      connection: 'loader-box', remote_path: 'composed.txt', local_path: target,
    })
    expect(read.isError).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('loader payload')
  }, 20_000)
})
