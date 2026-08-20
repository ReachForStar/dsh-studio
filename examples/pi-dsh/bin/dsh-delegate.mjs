#!/usr/bin/env node
/**
 * Delegate one task to a DeepSeek Harness JSON-RPC agent runtime and print the
 * final answer. This is the command the Pi Agent Skill (`skills/dsh/SKILL.md`)
 * instructs Pi to run, so the two products can collaborate in both directions:
 * dsh delegates to Pi through `subagent_pi`; Pi delegates to dsh through this
 * helper.
 *
 * Usage:
 *   node dsh-delegate.mjs <cordis.yml> <task text>
 *
 * Environment overrides:
 *   DSH_DELEGATE_COMMAND  runtime executable (default `dsh-jsonrpc-agent`)
 *   DSH_DELEGATE_ARGS     extra args before the config path (JSON array)
 *   DSH_DELEGATE_CWD      workspace for the child agent (default: process cwd)
 *   DSH_DELEGATE_PROVIDER provider route for the child (default deepseek-official)
 *   DSH_DELEGATE_MODEL    model for the child (default deepseek-v4-flash)
 */

import process from 'node:process'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const [configPath, ...taskParts] = process.argv.slice(2)
if (configPath === undefined || taskParts.length === 0) {
  process.stderr.write('usage: node dsh-delegate.mjs <cordis.yml> <task text>\n')
  process.exit(2)
}

const command = process.env.DSH_DELEGATE_COMMAND ?? 'dsh-jsonrpc-agent'
const args = JSON.parse(process.env.DSH_DELEGATE_ARGS ?? '[]')

const harness = new DeepSeekHarness({
  launch: { command, args: [...args, configPath] },
  cwd: process.env.DSH_DELEGATE_CWD ?? process.cwd(),
  provider: process.env.DSH_DELEGATE_PROVIDER ?? 'deepseek-official',
  model: process.env.DSH_DELEGATE_MODEL ?? 'deepseek-v4-flash',
})

let exitCode = 0
try {
  await harness.start()
  const result = await harness.run(taskParts.join(' '))
  process.stdout.write(`${result.finalResponse}\n`)
} catch (error) {
  process.stderr.write(`dsh-delegate failed: ${error instanceof Error ? error.message : String(error)}\n`)
  exitCode = 1
} finally {
  await harness.close()
}
process.exit(exitCode)
