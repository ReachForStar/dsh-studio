/**
 * Model-facing Consumer of the `ctx.ssh` capability seam: connection
 * management (`ssh_connect`/`ssh_connections`/`ssh_disconnect`/`ssh_test`),
 * remote command execution (`ssh_exec`), and SFTP file transfer
 * (`sftp_list`/`sftp_stat`/`sftp_read`/`sftp_write`/`sftp_mkdir`/`sftp_rm`/
 * `sftp_rename`). Local file paths on the transfer tools resolve against the
 * caller's session workspace; the remote side is the connection's SFTP
 * channel. Connections are shared per definition until `ssh_disconnect`.
 * @module @deepseek-ai/dsh-tool-ssh
 */

import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { GenericResultView, TerminalCallView, TerminalResultView, ToolExecution, ToolResult } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { SshService } from '@deepseek-ai/dsh-ssh'
import type { SshConnectionDefinition, SshRunResult } from '@deepseek-ai/dsh-ssh'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'

export const name = 'tool-ssh'
export const inject = ['tools', 'ssh', 'systemPrompt']

/** Validate a caller string argument. */
function requireString(value: unknown, label: string): string {
  /* v8 ignore next -- the tool schema rejects non-strings before this guard runs */
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`invalid ${label}: expected a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value.trim()
}

/** Validate an optional caller number argument. */
function requireOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  /* v8 ignore next -- the tool schema rejects non-numbers before this guard runs */
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid ${label}: expected a number, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Validate an optional caller boolean argument. */
function requireOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  /* v8 ignore next -- the tool schema rejects non-booleans before this guard runs */
  if (typeof value !== 'boolean') {
    throw new Error(`invalid ${label}: expected a boolean, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Resolve the local side of a transfer path against the session workspace. */
function resolveLocalPath(path: string, exec: { agent?: Agent }): string {
  const cwd = exec.agent?.session.header.cwd
  if (isAbsolute(path) || cwd === undefined) return path
  return resolvePath(cwd, path)
}

/** Resolve the connection argument (id or name) through the registry. */
function resolveConnection(ssh: SshService, connection: string): SshConnectionDefinition {
  return ssh.resolve(connection)
}

/** Detach an exec outcome into plain JSON data. */
function canonicalResult(result: SshRunResult) {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    durationMs: result.durationMs,
    stdout: { text: result.stdout, truncated: result.stdoutTruncated },
    stderr: { text: result.stderr, truncated: result.stderrTruncated },
  }
}

/** Model-facing text of one exec outcome, with the exit-status marker contract. */
function renderResult(value: ReturnType<typeof canonicalResult>): string {
  const body: string[] = []
  if (value.stdout.text.length > 0) body.push(value.stdout.text.replace(/\n$/, ''))
  if (value.stderr.text.length > 0) {
    body.push(`[stderr]\n${value.stderr.text.replace(/\n$/, '')}`)
  }
  const marker = value.timedOut
    ? `[timed out after ${value.timeoutMs} ms]`
    // v8 ignore start -- the executor throws TOOL_ABORTED before an aborted result is returned,
    // and remote signal kills are not produced by the test server
    : value.aborted
      ? '[aborted]'
      : value.signal !== null
        ? `[killed by signal: ${value.signal}]`
        : `[exit code: ${value.exitCode}]`
  /* v8 ignore stop */
  const text = body.join('\n')
  return text.length > 0 ? `${text}\n${marker}` : marker
}

/** Present completed exec output as a terminal; the pill comes from the marker text, never a guessed exit 0. */
function presentExecResult(_args: unknown, result: ToolResult): TerminalResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const text = block.text
  // A run cut short by the provider deadline or the caller's signal has no
  // real exit status; the marker text says so and no pill may be shown.
  const noExit = /\[timed out after \d+ ms\]\s*$/.test(text) || /\[aborted\]\s*$/.test(text)
  const parsed = parseExitStatus(text)
  return {
    card: 'terminal',
    ...parsed.body.length > 0 ? { output: parsed.body } : {},
    ...!noExit && 'exitCode' in parsed ? { exitCode: parsed.exitCode } : {},
    ...!noExit && 'signal' in parsed ? { signal: parsed.signal } : {},
  }
}

/** Generic fenced presentation shared by the non-terminal tools. */
function presentGeneric(_args: unknown, result: ToolResult): GenericResultView | undefined {
  void _args
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${block.text.replace(/\n+$/, '')}\n\`\`\`` }] }
}

/** One tool's model-facing result as a JSON summary. */
function summary(text: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text }]
}

/** Validate and normalize the ssh_connect argument payload. */
function validateConnectArgs(args: Record<string, unknown>): Record<string, unknown> {
  const name = requireString(args['name'], 'name')
  const host = requireString(args['host'], 'host')
  const username = requireString(args['username'], 'username')
  const auth = args['auth']
  // v8 ignore next -- the schema enum rejects invalid auth before this guard runs
  if (auth !== 'password' && auth !== 'privateKey') {
    throw new Error(`invalid auth: expected "password" or "privateKey", got ${JSON.stringify(auth)}`)
  }
  const input: Record<string, unknown> = { name, host, username }
  const port = requireOptionalNumber(args['port'], 'port')
  if (port !== undefined) input['port'] = port
  const connectTimeoutMs = requireOptionalNumber(args['connect_timeout_ms'], 'connect_timeout_ms')
  if (connectTimeoutMs !== undefined) input['connectTimeoutMs'] = connectTimeoutMs
  if (args['id'] !== undefined) {
    if (typeof args['id'] !== 'string' || args['id'].length === 0) {
      throw new Error(`invalid id: expected a non-empty string, got ${JSON.stringify(args['id'])}`)
    }
    input['id'] = args['id']
  }
  if (auth === 'password') {
    const password = args['password']
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('invalid password: password auth requires a non-empty password')
    }
    input['auth'] = { kind: 'password', password }
    return input
  }
  const privateKeyPath = requireString(args['private_key_path'], 'private_key_path')
  const passphrase = args['passphrase']
  /* v8 ignore next -- the schema rejects non-string passphrases before this guard runs */
  if (passphrase !== undefined && typeof passphrase !== 'string') {
    throw new Error(`invalid passphrase: expected a string, got ${JSON.stringify(passphrase)}`)
  }
  // v8 ignore start -- the passphrase-present branch is covered by the keyed connect test
  input['auth'] = {
    kind: 'privateKey',
    privateKeyPath,
    ...passphrase !== undefined && passphrase.length > 0 ? { passphrase } : {},
  }
  /* v8 ignore stop */
  return input
}

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:ssh',
    order: 106,
    text: 'SSH/SFTP tools operate on saved connections: `ssh_connect` persists a definition before `ssh_exec`/`sftp_*` can use it, and connections stay open until `ssh_disconnect`. Verify remote commands before running destructive ones.',
  })

  ctx.tools.register(defineTool({
    name: 'ssh_connect',
    description: 'Save a new SSH connection definition (or update one by passing its id). The definition persists in user settings and is usable by ssh_exec and the sftp_* tools; secrets never come back in results. List saved connections with ssh_connections.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique display name for the connection (also accepted wherever a connection id is).' },
      host: { type: 'string', required: true, description: 'Remote host name or IP address.' },
      username: { type: 'string', required: true, description: 'Remote login user.' },
      port: { type: 'number', description: 'Remote SSH port (default 22).' },
      auth: { type: 'string', required: true, enum: ['password', 'privateKey'], description: 'Authentication kind: "password" or "privateKey".' },
      password: { type: 'string', description: 'Password (required when auth is "password").' },
      private_key_path: { type: 'string', description: 'Absolute local path of the private key (required when auth is "privateKey").' },
      passphrase: { type: 'string', description: 'Private-key passphrase, when the key is encrypted.' },
      connect_timeout_ms: { type: 'number', description: 'Connection-establishment timeout in milliseconds (default 10000, range 1000-300000).' },
      id: { type: 'string', description: 'Id of an existing connection to update; omit to create a new one.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          host: { type: 'string', required: true },
          port: { type: 'number', required: true },
          username: { type: 'string', required: true },
          auth: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              kind: { type: 'string', required: true },
              passwordSet: { type: 'boolean' },
              privateKeyPath: { type: 'string' },
              passphraseSet: { type: 'boolean' },
            },
          },
          connectTimeoutMs: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `saved ssh connection "${value.name}" (${value.username}@${value.host}:${value.port})`,
      }],
    },
    async execute(args: Record<string, unknown>, _exec: ToolExecution) {
      const input = validateConnectArgs(args)
      const saved = await ctx.ssh.save(input)
      return ctx.ssh.toView(saved)
    },
    presentCall: () => ({ card: 'generic', title: 'ssh_connect', kind: 'execute', rawInput: 'save connection definition' }),
    presentResult: presentGeneric,
  }))

  ctx.tools.register(defineTool({
    name: 'ssh_connections',
    description: 'List every saved SSH connection definition (secret-free view). Use the returned id or name as the `connection` argument of ssh_exec and the sftp_* tools.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connections: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'number', required: true },
                username: { type: 'string', required: true },
                auth: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string' },
                    passwordSet: { type: 'boolean' },
                    privateKeyPath: { type: 'string' },
                    passphraseSet: { type: 'boolean' },
                  },
                },
                connectTimeoutMs: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.connections.length === 0
          ? 'no ssh connections saved'
          : value.connections.map(view => `- ${view.name}: ${view.username}@${view.host}:${view.port} (${view.id})`).join('\n'),
      }],
    },
    execute() {
      return Promise.resolve({ connections: ctx.ssh.list().map(definition => ctx.ssh.toView(definition)) })
    },
    presentCall: () => ({ card: 'generic', title: 'ssh_connections', kind: 'execute', rawInput: 'list saved connections' }),
    presentResult: presentGeneric,
  }))

  ctx.tools.register(defineTool({
    name: 'ssh_disconnect',
    description: 'Close the shared connection for one saved connection. Later ssh_exec/sftp_* calls reconnect automatically.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection id or name from ssh_connections.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => summary(value.closed ? 'ssh connection closed' : 'no open connection'),
    },
    async execute(args: Record<string, unknown>) {
      const definition = resolveConnection(ctx.ssh, requireString(args['connection'], 'connection'))
      await ctx.ssh.close(definition.id)
      return { closed: true }
    },
    presentCall: (args: Record<string, unknown>) => ({ card: 'generic', title: 'ssh_disconnect', kind: 'execute', rawInput: String(args['connection']) }),
    presentResult: presentGeneric,
  }))

  ctx.tools.register(defineTool({
    name: 'ssh_test',
    description: 'Probe one saved connection: connect, run a probe command, and close again. Reports the round-trip latency or the failure reason.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection id or name from ssh_connections.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          latencyMs: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => summary(value.ok ? `ssh connection ok (${value.latencyMs} ms)` : `ssh connection failed: ${String(value.error)}`),
    },
    async execute(args: Record<string, unknown>) {
      const connection = requireString(args['connection'], 'connection')
      try {
        const outcome = await ctx.ssh.test(connection)
        return outcome
      } catch (error) {
        // v8 ignore next -- providers throw SshError (an Error) exclusively; the unknown fallback is defensive
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: message }
      }
    },
    presentCall: (args: Record<string, unknown>) => ({ card: 'generic', title: 'ssh_test', kind: 'execute', rawInput: String(args['connection']) }),
    presentResult: presentGeneric,
  }))

  ctx.tools.register(defineTool({
    name: 'ssh_exec',
    description: 'Execute a command on a saved SSH connection and return its stdout/stderr. Each call runs in a fresh remote shell: no state (cwd, variables) persists between calls — pass `cwd` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`; commands that exceed the timeout are killed and reported as `[timed out ...]`. Long output is truncated to its tail with a truncation marker.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection id or name from ssh_connections.' },
      command: { type: 'string', required: true, description: 'The command to execute on the remote host.' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds. The provider applies its configured default and cap, and kills the command on expiry.' },
      cwd: { type: 'string', description: 'Remote working directory for this command; a `cd` prefix is applied on the remote side.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
          aborted: { type: 'boolean', required: true },
          timeoutMs: { type: 'number', required: true },
          durationMs: { type: 'number', required: true },
          stdout: { type: 'object', additionalProperties: false, required: true, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true } } },
          stderr: { type: 'object', additionalProperties: false, required: true, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true } } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args: Record<string, unknown>, exec: ToolExecution) {
      const connection = requireString(args['connection'], 'connection')
      const command = requireString(args['command'], 'command')
      const timeoutMs = requireOptionalNumber(args['timeout_ms'], 'timeout_ms')
      const definition = resolveConnection(ctx.ssh, connection)
      const spec = ctx.ssh.resolveExec({
        command,
        ...timeoutMs !== undefined ? { timeoutMs } : {},
        // v8 ignore start -- the remote cwd prefix assumes a POSIX shell; the cwd suite skips on Windows
        ...args['cwd'] !== undefined ? { cwd: requireString(args['cwd'], 'cwd') } : {},
        /* v8 ignore stop */
        signal: exec.signal,
      })
      const handle = await ctx.ssh.connect(definition.id)
      const result = await handle.exec(spec)
      if (result.aborted) {
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return canonicalResult(result)
    },
    presentCall: (args: Record<string, unknown>): TerminalCallView => ({
      card: 'terminal',
      title: String(args['command']),
      description: `ssh ${String(args['connection'])}`,
    }),
    presentResult: presentExecResult,
  }))

  ctx.tools.register(defineTool({
    name: 'sftp_list',
    description: 'List one remote directory over SFTP (non-recursive). Entries report type, size, mtime, and mode.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection id or name from ssh_connections.' },
      path: { type: 'string', required: true, description: 'Remote directory path to list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true },
                size: { type: 'number', required: true },
                mtimeMs: { type: 'number', required: true },
                mode: { type: 'number', required: true },
                owner: { type: 'string' },
                group: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.entries.length === 0
          ? `(empty directory ${value.path})`
          : value.entries.map(entry => `${entry.type === 'dir' ? 'd' : entry.type === 'symlink' ? 'l' : '-'} ${entry.size.toString().padStart(10)} ${entry.name}`).join('\n'),
      }],
    },
    async execute(args: Record<string, unknown>) {
      const definition = resolveConnection(ctx.ssh, requireString(args['connection'], 'connection'))
      const path = requireString(args['path'], 'path')
      const handle = await ctx.ssh.connect(definition.id)
      const entries = await handle.sftp.list(path)
      return { path, entries }
    },
    presentCall: (args: Record<string, unknown>) => ({ card: 'generic', title: 'sftp_list', kind: 'execute', rawInput: String(args['path']) }),
    presentResult: presentGeneric,
  }))

  ctx.tools.register(defineTool({
    name: 'sftp_stat',
    description: 'Stat one remote path over SFTP without following symlinks.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection id or name from ssh_connections.' },
      path: { type: 'string', required: true, description: 'Remote path to stat.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          type: { type: 'string', required: true },
          size: { type: 'number', required: true },
          mtimeMs: { type: 'number', required: true },
          mode: { type: 'number', required: true },
          owner: { type: 'string' },
          group: { type: 'string' },
        },
      },
      render: (_args, value) => summary(`${value.type} ${value.size} bytes ${value.name}`),
    },
    async execute(args: Record<string, unknown>) {
      const definition = resolveConnection(ctx.ssh, requireString(args['connection'], 'connection'))
      const path = requireString(args['path'], 'path')
      const handle = await ctx.ssh.connect(definition.id)
      return handle.sftp.stat(path)
    },
    presentCall: (args: Record<string, unknown>) => ({ card: 'generic', title: 'sftp_stat', kind: 'execute', rawInput: String(args['path']) }),
    presentResult: presentGeneric,
  }))

  ctx.tools.register(defineTool({
    name: 'sftp_read',
    description: 'Download one remote file to a local path over SFTP. The local file must not exist unless `overwrite` is set; a failed transfer removes the partial local file.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection id or name from ssh_connections.' },
      remote_path: { type: 'string', required: true, description: 'Remote file path to download.' },
      local_path: { type: 'string', required: true, description: 'Local destination path; relative paths resolve against the session workspace.' },
      overwrite: { type: 'boolean', description: 'Replace an existing local file (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => summary(`downloaded ${value.bytes} bytes`),
    },
    async execute(args: Record<string, unknown>, exec: ToolExecution) {
      const definition = resolveConnection(ctx.ssh, requireString(args['connection'], 'connection'))
      const remotePath = requireString(args['remote_path'], 'remote_path')
      const localPath = resolveLocalPath(requireString(args['local_path'], 'local_path'), exec)
      const handle = await ctx.ssh.connect(definition.id)
      return handle.sftp.readFile(remotePath, localPath, {
        ...requireOptionalBoolean(args['overwrite'], 'overwrite') === true ? { overwrite: true } : {},
      })
    },
    presentCall: (args: Record<string, unknown>) => ({
      card: 'generic',
      title: 'sftp_read',
      kind: 'execute',
      rawInput: `${String(args['remote_path'])} -> ${String(args['local_path'])}`,
    }),
    presentResult: presentGeneric,
  }))

  ctx.tools.register(defineTool({
    name: 'sftp_write',
    description: 'Upload one local file to a remote path over SFTP. The remote directory must already exist (use sftp_mkdir first).',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection id or name from ssh_connections.' },
      local_path: { type: 'string', required: true, description: 'Local source path; relative paths resolve against the session workspace.' },
      remote_path: { type: 'string', required: true, description: 'Remote destination path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => summary(`uploaded ${value.bytes} bytes`),
    },
    async execute(args: Record<string, unknown>, exec: ToolExecution) {
      const definition = resolveConnection(ctx.ssh, requireString(args['connection'], 'connection'))
      const localPath = resolveLocalPath(requireString(args['local_path'], 'local_path'), exec)
      const remotePath = requireString(args['remote_path'], 'remote_path')
      const handle = await ctx.ssh.connect(definition.id)
      return handle.sftp.writeFile(localPath, remotePath)
    },
    presentCall: (args: Record<string, unknown>) => ({
      card: 'generic',
      title: 'sftp_write',
      kind: 'execute',
      rawInput: `${String(args['local_path'])} -> ${String(args['remote_path'])}`,
    }),
    presentResult: presentGeneric,
  }))

  ctx.tools.register(defineTool({
    name: 'sftp_mkdir',
    description: 'Create one remote directory over SFTP. With `recursive`, missing parents are created too.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection id or name from ssh_connections.' },
      path: { type: 'string', required: true, description: 'Remote directory path to create.' },
      recursive: { type: 'boolean', description: 'Create missing parents (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => summary(`created directory ${value.path}`),
    },
    async execute(args: Record<string, unknown>) {
      const definition = resolveConnection(ctx.ssh, requireString(args['connection'], 'connection'))
      const path = requireString(args['path'], 'path')
      const handle = await ctx.ssh.connect(definition.id)
      await handle.sftp.mkdir(path, {
        ...requireOptionalBoolean(args['recursive'], 'recursive') === true ? { recursive: true } : {},
      })
      return { path }
    },
    presentCall: (args: Record<string, unknown>) => ({ card: 'generic', title: 'sftp_mkdir', kind: 'execute', rawInput: String(args['path']) }),
    presentResult: presentGeneric,
  }))

  ctx.tools.register(defineTool({
    name: 'sftp_rm',
    description: 'Remove one remote file or directory over SFTP. Directories require `recursive: true` and are deleted depth-first; symlinks are unlinked, never followed.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection id or name from ssh_connections.' },
      path: { type: 'string', required: true, description: 'Remote path to remove.' },
      recursive: { type: 'boolean', description: 'Remove a directory tree (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true },
        },
      },
      render: (_args, _value) => summary('removed'),
    },
    async execute(args: Record<string, unknown>) {
      const definition = resolveConnection(ctx.ssh, requireString(args['connection'], 'connection'))
      const path = requireString(args['path'], 'path')
      const handle = await ctx.ssh.connect(definition.id)
      await handle.sftp.remove(path, {
        ...requireOptionalBoolean(args['recursive'], 'recursive') === true ? { recursive: true } : {},
      })
      return { removed: true }
    },
    presentCall: (args: Record<string, unknown>) => ({ card: 'generic', title: 'sftp_rm', kind: 'execute', rawInput: String(args['path']) }),
    presentResult: presentGeneric,
  }))

  ctx.tools.register(defineTool({
    name: 'sftp_rename',
    description: 'Rename or move one remote path over SFTP.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection id or name from ssh_connections.' },
      from: { type: 'string', required: true, description: 'Current remote path.' },
      to: { type: 'string', required: true, description: 'Destination remote path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          renamed: { type: 'boolean', required: true },
        },
      },
      render: (_args, _value) => summary('renamed'),
    },
    async execute(args: Record<string, unknown>) {
      const definition = resolveConnection(ctx.ssh, requireString(args['connection'], 'connection'))
      const from = requireString(args['from'], 'from')
      const to = requireString(args['to'], 'to')
      const handle = await ctx.ssh.connect(definition.id)
      await handle.sftp.rename(from, to)
      return { renamed: true }
    },
    presentCall: (args: Record<string, unknown>) => ({
      card: 'generic',
      title: 'sftp_rename',
      kind: 'execute',
      rawInput: `${String(args['from'])} -> ${String(args['to'])}`,
    }),
    presentResult: presentGeneric,
  }))
}
