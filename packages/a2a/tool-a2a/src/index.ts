import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@reachforstar/dsh-a2a'

export const name = 'tool-a2a'
export const inject = ['tools', 'a2a']

/**
 * Register the A2A tools.
 * @param ctx - the owning host context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'a2a_peers',
    description:
      'List the remote A2A agents this deployment can call, with the name each '
      + 'is addressed by and the display name from its published agent card. Call '
      + 'it before `a2a_send` when you do not already know which peers exist. It '
      + 'reports a peer whose card could not be read beside that peer instead of '
      + 'failing the whole listing.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peers: {
            type: 'array',
            required: true,
            description: 'Every configured peer, in configuration order.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true, description: 'Name to pass as `peer`.' },
                url: { type: 'string', required: true, description: 'Endpoint the peer is called at.' },
                title: { type: 'string', description: 'Display name from the peer card, when readable.' },
                error: { type: 'string', description: 'Why the card could not be read, when it could not.' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.peers.length === 0
          ? 'No A2A peers are configured for this deployment.'
          : value.peers.map(peer => peer.error === undefined
            ? `- ${peer.name}: ${peer.title ?? '(untitled)'} at ${peer.url}`
            : `- ${peer.name}: unreachable at ${peer.url} (${peer.error})`).join('\n'),
      }],
    },
    execute: async () => ({ peers: await ctx.a2a.inspect() }),
    presentCall: () => ({ card: 'generic', title: 'List A2A peers', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'a2a_send',
    description:
      'Send one message to a remote A2A agent and return its answer. Address a '
      + 'peer by the name `a2a_peers` reports, or by an endpoint URL. The peer '
      + 'works in its own environment: it can read and write files there, but it '
      + 'cannot see this workspace. Pass the `contextId` a previous call returned '
      + 'to continue the same conversation, so the peer keeps its earlier turns; '
      + 'omit it to start a new one. This call waits for the peer to finish, which '
      + 'can take minutes — prefer delegating a complete unit of work over many '
      + 'small round trips.',
    parameters: {
      peer: {
        type: 'string',
        required: true,
        description: 'Peer name from `a2a_peers`, or the endpoint URL of an unconfigured agent.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to send, as a self-contained request the peer can act on.',
      },
      contextId: {
        type: 'string',
        description: 'Conversation to continue, from an earlier answer; omit to start a new one.',
      },
      taskId: {
        type: 'string',
        description: 'Task to continue, from an earlier answer; omit unless you are resuming that task.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peer: { type: 'string', required: true, description: 'Peer that answered.' },
          text: { type: 'string', required: true, description: 'The peer answer text.' },
          contextId: { type: 'string', description: 'Conversation identity; pass it back to continue.' },
          taskId: { type: 'string', description: 'Task identity; pass it back to continue that task.' },
          state: { type: 'string', description: 'Task state the peer ended in.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args) => {
      const reply = await ctx.a2a.send({
        peer: args.peer,
        text: args.message,
        ...args.contextId === undefined ? {} : { contextId: args.contextId },
        ...args.taskId === undefined ? {} : { taskId: args.taskId },
      })
      return {
        peer: args.peer,
        text: reply.text,
        ...reply.contextId === undefined ? {} : { contextId: reply.contextId },
        ...reply.taskId === undefined ? {} : { taskId: reply.taskId },
        ...reply.state === undefined ? {} : { state: reply.state },
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Message A2A peer ${args.peer}`,
      kind: 'other',
      rawInput: args.message,
    }),
  }))
}
