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
  return { session, translator, emit: (event: unknown) => { listener(event) } }
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

  it('carries the pending dsh request source (rpcId) onto the user message', () => {
    const { session, translator, emit } = harness()
    // The browser-prompt source variant (kind 'user' + rpcId) is declared by
    // the api-session-controller layer; assert the type here to model it.
    const source = { kind: 'user' as const, rpcId: 'req-42' }
    translator.setPendingUserSource(source as unknown as Parameters<PiEventTranslator['setPendingUserSource']>[0])
    emit({ type: 'turn_start' })
    emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })

    const users = session.snapshotEvents().filter(event => event.type === 'user/message')
    expect(users).toHaveLength(1)
    expect(users[0]?.data.source).toEqual(source)
  })

  it('skips Pi custom injections and keeps only the real user message', () => {
    const { session, emit } = harness()

    emit({ type: 'turn_start' })
    emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })
    emit({ type: 'message_end', message: { role: 'custom', customType: 'x', content: 'project conventions…' } })
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } })
    emit({ type: 'turn_end', message: { stopReason: 'stop' } })

    const users = session.snapshotEvents().filter(event => event.type === 'user/message')
    expect(users).toHaveLength(1)
    expect(users[0]?.data.content).toEqual([{ type: 'text', text: 'hi' }])
  })
})
