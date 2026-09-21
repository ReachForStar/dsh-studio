#!/usr/bin/env node
/**
 * Local A2A stack: Kafka cluster, the three A2A gateways, and the Web app.
 *
 * `up` starts only what is not already running: the Kafka containers are skipped
 * while the compose project reports them up, a gateway is skipped while its port
 * answers, and the Web app is skipped while its port answers. `down` stops the
 * processes this script started and leaves everything else alone. `status`
 * reports each component without changing anything.
 *
 * The bridge checkout owns the gateway code; this repository owns the stack
 * definition (compose file, bridge config) and exports `A2A_CONFIG` so gateways
 * and the Web app read one configuration.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory holding this script; anchors every repository-relative path. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Repository root. */
const ROOT = resolve(HERE, '..', '..')

/** Runtime state: logs and the record of processes this script started. */
const STATE = join(ROOT, 'tmp', 'a2a-stack')

/** Kafka compose file owned by this repository. */
const COMPOSE = join(HERE, 'kafka', 'docker-compose.yml')

/** Bridge configuration shared by the gateways and the Web app. */
const CONFIG = join(HERE, 'a2a.config.json')

/** Gateway definitions: bridge package, listening port, log name. */
const GATEWAYS = [
  { name: 'pi', package: 'pi-gateway', port: 9310 },
  { name: 'claude-code', package: 'cc-gateway', port: 9320 },
  { name: 'opencode', package: 'oc-gateway', port: 9330 },
]

/** Web app port, matching the CLI default. */
const WEB_PORT = 3080

/** Bridge checkout supplying the gateway entry points; the vendored copy is the default. */
const BRIDGE = process.env.A2A_BRIDGE_DIR ?? join(HERE, 'gateway')

/** Kafka compose project name, pinned in the compose file. */
const KAFKA_PROJECT = 'kafka'

/** Answer whether a TCP port accepts a connection. */
async function listening(port) {
  return await new Promise(resolvePort => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = value => { socket.destroy(); resolvePort(value) }
    socket.setTimeout(700)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** Run one command to completion and return its captured result. */
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false })
  return {
    status: result.status ?? (result.error === undefined ? 0 : 1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  }
}

/** Docker command prefix: the Windows client when present, otherwise WSL. */
let dockerPrefix
function dockerCommand() {
  if (dockerPrefix !== undefined) return dockerPrefix
  const executable = process.platform === 'win32' ? 'docker.exe' : 'docker'
  const probe = capture(executable, ['version', '--format', '{{.Server.Version}}'])
  dockerPrefix = probe.status === 0 ? { kind: 'direct', executable } : { kind: 'wsl' }
  return dockerPrefix
}

/** Run docker with the resolved client, forwarding arguments verbatim. */
function docker(args) {
  const prefix = dockerCommand()
  if (prefix.kind === 'direct') return capture(prefix.executable, args)
  return capture('wsl.exe', ['-e', 'bash', '-lc', `docker ${args.map(shellQuote).join(' ')}`])
}

/** Quote one argument for the WSL shell string. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/** Translate a Windows path for a command running inside WSL. */
function wslPath(path) {
  const result = capture('wsl.exe', ['-e', 'wslpath', '-a', path])
  if (result.status !== 0) throw new Error(`wslpath failed for ${path}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** Container name and state per compose service, empty when the project is absent. */
function kafkaContainers() {
  const result = docker(['ps', '--all', '--filter', `label=com.docker.compose.project=${KAFKA_PROJECT}`, '--format', '{{.Names}}\t{{.State}}'])
  if (result.status !== 0) return { error: result.stderr.trim(), containers: [] }
  const containers = result.stdout.split('\n').filter(Boolean).map(line => {
    const [name, state] = line.split('\t')
    return { name, state: state ?? 'unknown' }
  })
  return { error: '', containers }
}

/** Bring the Kafka cluster up unless every container already reports running. */
function ensureKafka() {
  const { error, containers } = kafkaContainers()
  if (error !== '') throw new Error(`docker is unavailable: ${error}`)
  if (containers.length === 3 && containers.every(container => container.state === 'running')) {
    console.log(`kafka      : up (skipped, ${containers.map(container => container.name).join(', ')})`)
    return
  }
  const composeFile = wslPath(COMPOSE)
  console.log(`kafka      : starting (${containers.length} container(s) present)`)
  const result = docker(['compose', '-f', composeFile, 'up', '-d'])
  if (result.status !== 0) throw new Error(`docker compose up failed: ${result.stderr.trim() || result.stdout.trim()}`)
  console.log('kafka      : compose up issued')
}

/** Start one gateway when its port is free, recording the child process id. */
function ensureGateway(gateway, started) {
  const entry = join(BRIDGE, 'packages', gateway.package, 'dist', 'index.js')
  if (!existsSync(entry)) {
    console.log(`gateway ${gateway.name.padEnd(2)}: skipped — missing ${entry} (build the bridge: npm run build)`)
    return
  }
  const log = openSync(join(STATE, `gw-${gateway.name}.log`), 'a')
  const child = spawn(process.execPath, [entry], {
    cwd: BRIDGE,
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, A2A_CONFIG: CONFIG },
  })
  child.unref()
  started.push({ kind: 'gateway', name: gateway.name, port: gateway.port, pid: child.pid })
  console.log(`gateway ${gateway.name.padEnd(2)}: starting on ${gateway.port} (pid ${String(child.pid)})`)
}

/** Bring the Web app up unless its port already answers. */
function ensureWeb(started) {
  const entry = join(ROOT, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(entry)) {
    console.log(`web        : skipped — missing ${entry} (run: pnpm run build)`)
    return
  }
  const log = openSync(join(STATE, 'web.log'), 'a')
  const child = spawn(process.execPath, [entry, 'web', '--no-open'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, A2A_CONFIG: CONFIG },
  })
  child.unref()
  started.push({ kind: 'web', name: 'web', port: WEB_PORT, pid: child.pid })
  console.log(`web        : starting on ${WEB_PORT} (pid ${String(child.pid)})`)
}

/** Read the record of processes this script started. */
function startedRecord() {
  const file = join(STATE, 'started.json')
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

/** Append processes this run started to the record used by `down`. */
function recordStarted(started) {
  if (started.length === 0) return
  writeFileSync(join(STATE, 'started.json'), `${JSON.stringify([...startedRecord(), ...started], null, 2)}\n`, 'utf8')
}

/** Report one component's state, pending when its port does not answer yet. */
async function report() {
  const { error, containers } = kafkaContainers()
  console.log(`kafka      : ${error !== '' ? `unknown (${error})` : containers.length === 0 ? 'absent' : containers.map(container => `${container.name}=${container.state}`).join(' ')}`)
  for (const gateway of GATEWAYS) {
    console.log(`gateway ${gateway.name.padEnd(2)}: ${await listening(gateway.port) ? `listening on ${gateway.port}` : 'not listening'}`)
  }
  console.log(`web        : ${await listening(WEB_PORT) ? `listening on ${WEB_PORT}` : 'not listening'}`)
  console.log(`config     : ${CONFIG}`)
  console.log(`bridge     : ${BRIDGE}`)
}

/** Wait until every gateway and Web port answers, or the deadline passes. */
async function waitForPorts(deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs
  const targets = [...GATEWAYS.map(gateway => gateway.port), WEB_PORT]
  const pending = new Set(targets)
  while (pending.size > 0 && Date.now() < deadline) {
    for (const port of [...pending]) {
      if (await listening(port)) pending.delete(port)
    }
    if (pending.size > 0) await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  return [...pending]
}

/** Stop the recorded processes owned by this stack. */
async function down(includeKafka) {
  const record = startedRecord()
  for (const entry of record) {
    try {
      process.kill(entry.pid, 'SIGTERM')
      console.log(`stopped   : ${entry.kind} ${entry.name} (pid ${String(entry.pid)})`)
    } catch {
      console.log(`already   : ${entry.kind} ${entry.name} (pid ${String(entry.pid)}) is gone`)
    }
  }
  writeFileSync(join(STATE, 'started.json'), '[]\n', 'utf8')
  if (includeKafka) {
    const composeFile = wslPath(COMPOSE)
    const result = docker(['compose', '-f', composeFile, 'down'])
    console.log(result.status === 0 ? 'kafka     : stopped' : `kafka     : stop failed (${result.stderr.trim()})`)
  } else {
    console.log('kafka     : left running (pass --kafka to stop the cluster)')
  }
  const stillRunning = []
  // SIGTERM settles asynchronously; poll briefly so the report describes the end state.
  const shutdownDeadline = Date.now() + 8_000
  const portsToCheck = [...GATEWAYS.map(gateway => gateway.port), WEB_PORT]
  let remaining = portsToCheck
  while (remaining.length > 0 && Date.now() < shutdownDeadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 400))
    const answers = await Promise.all(remaining.map(async port => (await listening(port)) ? port : undefined))
    remaining = answers.filter(port => port !== undefined)
  }
  stillRunning.push(...remaining)
  if (stillRunning.length > 0) {
    console.log(`ports still serving (started outside this stack): ${stillRunning.join(', ')}`)
  }
}

async function main() {
  const command = process.argv[2] ?? 'up'
  const includeKafka = process.argv.includes('--kafka')
  mkdirSync(STATE, { recursive: true })

  if (command === 'status') {
    await report()
    return
  }
  if (command === 'down') {
    await down(includeKafka)
    return
  }
  if (command !== 'up') {
    console.error('usage: node deploy/a2a/stack.mjs [up|down|status] [--kafka]')
    process.exitCode = 1
    return
  }

  if (!existsSync(BRIDGE)) {
    console.log(`bridge     : absent at ${BRIDGE}; gateways need the checkout (set A2A_BRIDGE_DIR)`)
  }
  ensureKafka()
  const started = []
  for (const gateway of GATEWAYS) {
    if (await listening(gateway.port)) {
      console.log(`gateway ${gateway.name.padEnd(2)}: up (skipped, port ${gateway.port})`)
      continue
    }
    ensureGateway(gateway, started)
  }
  if (await listening(WEB_PORT)) {
    console.log(`web        : up (skipped, port ${WEB_PORT})`)
  } else {
    ensureWeb(started)
  }
  recordStarted(started)
  const pending = await waitForPorts()
  if (pending.length > 0) {
    console.log(`pending    : ${pending.join(', ')} did not answer within 30s — see ${join(STATE, 'gw-*.log')} and ${join(STATE, 'web.log')}`)
  }
  await report()
}

await main()
