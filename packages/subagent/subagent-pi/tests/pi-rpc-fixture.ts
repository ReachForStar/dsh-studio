/**
 * Scripted Pi RPC server used by the unit suite. Reads JSONL commands from
 * stdin, writes responses and events to stdout, and plays one scenario
 * selected by argv[2]. The provider drives this process exactly like a real
 * `pi --mode rpc` child.
 */

import process from 'node:process'

const scenario = process.argv[2] ?? 'complete'
/** The exact final answer the `complete` scenarios return. */
export const PI_FIXTURE_SENTINEL = 'PI_FIXTURE_SENTINEL_0_84'

function write(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function respond(
  id: string | undefined,
  command: string,
  data?: unknown,
  error?: string,
): void {
  if (error !== undefined) {
    write({ id, type: 'response', command, success: false, error })
    return
  }
  write(data === undefined
    ? { id, type: 'response', command, success: true }
    : { id, type: 'response', command, success: true, data })
}

function handleLine(line: string): void {
  let command: Record<string, unknown>
  try {
    command = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  const type = command.type
  const id = typeof command.id === 'string' ? command.id : undefined
  if (type === 'get_state') {
    if (scenario === 'crash') {
      process.exit(7)
    }
    respond(id, 'get_state', { sessionId: 'fixture-session' })
    if (scenario === 'bad-json') {
      write('this is not json\n')
    }
    return
  }
  // `hold` answers only the readiness probe and `abort`; every other command
  // is ignored so the run waits for cancellation.
  if (scenario === 'hold' && type !== 'abort') {
    return
  }
  if (type === 'extension_ui_response') {
    return
  }
  if (type === 'abort') {
    respond(id, 'abort')
    return
  }
  if (type === 'prompt') {
    if (scenario === 'prompt-error') {
      respond(id, 'prompt', undefined, 'fixture prompt rejected')
      return
    }
    if (scenario === 'extension-ui') {
      write({
        type: 'extension_ui_request',
        id: 'fixture-ui-1',
        method: 'select',
        title: 'fixture choice',
        options: ['a', 'b'],
      })
    }
    respond(id, 'prompt')
    write({ type: 'agent_settled' })
    return
  }
  if (type === 'get_last_assistant_text') {
    respond(
      id,
      'get_last_assistant_text',
      scenario === 'no-answer' ? {} : { text: PI_FIXTURE_SENTINEL },
    )
    return
  }
  respond(id, String(type), undefined, `fixture does not know command ${String(type)}`)
}

for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
  const text = chunk.toString('utf8')
  const lines = text.split('\n')
  for (const line of lines) {
    if (line.length > 0) {
      handleLine(line)
    }
  }
}
process.exit(0)
