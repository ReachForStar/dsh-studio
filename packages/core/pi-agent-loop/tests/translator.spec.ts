import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { PiEventTranslator } from '@deepseek-ai/dsh-pi-agent-loop'

/** A translator wired to a fresh dsh Session with a captured Pi event emitter. */
function harness() {
  const session = Session.create(SessionId('pi-s'))
  const translator = new PiEventTranslator(session)
  let listener: (event: unknown) => void = () => {}
  translator.subscribe({
    subscribe(fn: (event: unknown) => void) { listener = fn; return () => {} },
  })
  return { session, emit: (event: unknown) => { listener(event) } }
}

describe('PiEventTranslator', () => {
  it('folds a text-only turn into the dsh log', () => {
    const { session, emit } = harness()

    emit({ type: 'turn_start' })
    emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })
    emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], stopReason: 'stop' },
    })
    emit({ type: 'turn_end', message: { stopReason: 'stop' } })

    expect(session.snapshotEvents().map(event => event.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
  })

  it('records tool calls and results inside the step', () => {
    const { session, emit } = harness()

    emit({ type: 'turn_start' })
    emit({ type: 'message_end', message: { role: 'user', content: 'list files' } })
    emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }],
        stopReason: 'toolUse',
      },
    })
    emit({ type: 'tool_execution_end', toolCallId: 'call-1', isError: false, result: { content: [{ type: 'text', text: 'a.txt' }] } })
    emit({ type: 'turn_end', message: { stopReason: 'stop' } })

    expect(session.snapshotEvents().map(event => event.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'turn/end',
    ])
  })
})
