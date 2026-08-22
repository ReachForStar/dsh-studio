/**
 * Real-composition guard for the SSH tool family: a test-only cordis.yml boots
 * the actual settings provider, the real ssh2-backed executor, and the tool
 * plugin through the Loader, then the guarded executor drives a save → exec →
 * download journey against a real in-process SSH server.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSshService from '@deepseek-ai/dsh-ssh-local'
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
  it('boots from cordis.yml and completes a save → exec → download journey', async () => {
    server = await TestSshServer.start()
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-ssh-loader-'))
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, '')

    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: settings',
      "  name: '@deepseek-ai/dsh-settings-file'",
      '  config:',
      `    path: ${JSON.stringify(settingsPath)}`,
      '    debounceMs: 10',
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-ssh-local'",
      '  config:',
      '    defaultExecTimeoutMs: 60000',
      '    outputMaxBytes: 65536',
      "- name: '@deepseek-ai/dsh-tool-ssh'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-ssh-local', LocalSshService],
      ['@deepseek-ai/dsh-tool-ssh', ToolSsh],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('ssh_exec')

    const execute = (name: string, args: Record<string, unknown>) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`loader-${name}`),
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
