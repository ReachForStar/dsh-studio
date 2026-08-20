/**
 * Keyless REAL-composition proof for the Pi → dsh delegation half: the
 * `dsh-delegate.mjs` helper (the command the Pi Agent Skill instructs Pi to
 * run) spawns a COMPLETE dsh JSON-RPC runtime from a scripted child
 * composition, submits one prompt, and prints the child's final answer. The
 * child's scripted model echoes its process cwd, so the answer proves the
 * workspace reached the child across the delegation wire.
 */

import { mkdir, mkdtemp, realpath, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const delegateScript = fileURLToPath(new URL('../bin/dsh-delegate.mjs', import.meta.url))
const skillPath = fileURLToPath(new URL('../skills/dsh/SKILL.md', import.meta.url))
const childConfig = fileURLToPath(new URL(
  '../../jsonrpc-agent/tests/fixtures/subagent/subagent-dsh-sdk/child.cordis.yml',
  import.meta.url,
))
const runtimeBin = fileURLToPath(new URL('../../../packages/examples/jsonrpc-demo/src/bin.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('Pi → dsh delegation helper', () => {
  it('delegates a task to a scripted child runtime and returns its final answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pi-dsh-e2e-'))
    try {
      const workspace = join(root, 'workspace')
      await mkdir(workspace)
      // The child launch honours the same src/lib mode as the driving
      // harness, per the shared example-launch resolver (testing policy
      // forbids hand-written `--import tsx` argv for example subprocesses).
      const launch = resolveExampleLaunch({
        srcBin: runtimeBin,
        configArgs: [],
        tsconfigPath: repoTsconfig,
      })
      const result = await execa(
        process.execPath,
        [delegateScript, childConfig, 'Where do you run?'],
        {
          cwd: workspace,
          timeout: 120_000,
          env: {
            ...process.env,
            ...launch.env,
            DSH_DELEGATE_COMMAND: launch.command,
            DSH_DELEGATE_ARGS: JSON.stringify(launch.args),
            DSH_DELEGATE_PROVIDER: 'mock',
            DSH_DELEGATE_MODEL: 'mock-echo',
          },
        },
      )
      expect(result.stdout.trim()).toBe(`child cwd: ${await realpath(workspace)}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 135_000)

  it('documents the exact delegate invocation in the Pi Agent Skill', async () => {
    const skill = await readFile(skillPath, 'utf8')
    expect(skill).toContain('dsh-delegate.mjs')
    expect(skill).toContain('DSH_DELEGATE_COMMAND')
    expect(skill).toContain('DSH_DELEGATE_CWD')
  })
})
