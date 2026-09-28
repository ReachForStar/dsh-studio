import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'

const env = process.env
const invocation = pnpmInvocation(['run', 'build:lib'], env)
console.log('command:', invocation.command)
console.log('args:', invocation.args)
console.log('running build:lib via spawnSync...')

const result = spawnSync(invocation.command, invocation.args, {
  cwd: resolve(import.meta.dirname, '..'),
  env,
  stdio: 'inherit',
})
console.log('status:', result.status)
console.log('signal:', result.signal)
if (result.error) console.log('error:', result.error)