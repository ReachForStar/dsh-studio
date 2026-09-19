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
      + 'is addressed by, the display name from its published agent card, and the '
      + 'skills it accepts. Call it before `a2a_send` when you do not already know '
      + 'which peers exist. It reports a peer whose card could not be read beside '
      + 'that peer instead of failing the whole listing.',
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
                skills: {
                  type: 'array',
                  description: 'Skills the peer accepts, to pass as `skill`; the first is its default.',
                  items: { type: 'string' },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.peers.length === 0
          ? 'No A2A peers are configured for this deployment.'
          : value.peers.map((peer) => {
            const skills = peer.skills === undefined || peer.skills.length === 0
              ? ''
              : ` — skills: ${peer.skills.join(', ')}`
            return peer.error === undefined
              ? `- ${peer.name}: ${peer.title ?? '(untitled)'} at ${peer.url}${skills}`
              : `- ${peer.name}: unreachable at ${peer.url} (${peer.error})${skills}`
          }).join('\n'),
      }],
    },
    execute: async () => ({
      peers: (await ctx.a2a.inspect()).map(peer => ({
        ...peer,
        skills: ctx.a2a.skills(peer.name),
      })),
    }),
    presentCall: () => ({ card: 'generic', title: 'List A2A peers', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'a2a_send',
    description:
      'Send one task to a remote A2A agent and return its answer. Address a '
      + 'peer by the name `a2a_peers` reports, or by an endpoint URL. The peer '
      + 'works in its own environment: it can read and write files there, but it '
      + 'cannot see this workspace. Pass the `contextId` a previous call returned '
      + 'to continue the same conversation, so the peer keeps its earlier turns; '
      + 'omit it to start a new one.\n\n'
      + 'Choose the skill the peer should work under, such as code review or '
      + 'coding; `a2a_peers` lists what each peer accepts and the peer uses its '
      + 'default when you omit one. `mode: "direct"` waits for the answer, which '
      + 'can take minutes — prefer delegating a complete unit of work over many '
      + 'small round trips. `mode: "bus"` publishes the task and returns as soon '
      + 'as it is claimed: use it for work that outlives this turn, and add '
      + '`wait: true` when you also want the answer.',
    parameters: {
      peer: {
        type: 'string',
        required: true,
        description: 'Peer name from `a2a_peers`, or the endpoint URL of an unconfigured agent.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The task text, as a self-contained request the peer can act on.',
      },
      skill: {
        type: 'string',
        description: 'Skill the peer works under, from `a2a_peers`; omit to use the peer default.',
      },
      workspace: {
        type: 'string',
        description: 'Directory the peer runs in, when it should not use its own default.',
      },
      mode: {
        type: 'string',
        description: 'Channel: "direct" waits for the answer, "bus" publishes and returns early.',
        enum: ['direct', 'bus'],
      },
      wait: {
        type: 'boolean',
        description: 'On "bus", wait for the task to finish before returning.',
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
          skill: { type: 'string', description: 'Skill the peer worked under.' },
          mode: { type: 'string', description: 'Channel the task travelled on.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args) => {
      const bridge = ctx.a2a.bridgeConfig
      const skills = ctx.a2a.skills(args.peer)
      if (bridge !== undefined && args.peer in bridge.agents) {
        // A bridge agent runs one of the skills its gateway advertises; the
        // first in the deployment's map is the one the gateway falls back to.
        const skill = args.skill ?? skills[0]
        if (skill === undefined) {
          throw new Error(`a2a: bridge agent "${args.peer}" advertises no skill, so one must be configured`)
        }
        const mode = args.mode ?? 'direct'
        const reply = await ctx.a2a.dispatch({
          agent: args.peer,
          skill,
          text: args.message,
          mode,
          ...args.workspace === undefined ? {} : { workspace: args.workspace },
          ...args.contextId === undefined ? {} : { contextId: args.contextId },
          ...args.wait === undefined ? {} : { wait: args.wait },
        })
        return {
          peer: args.peer,
          text: reply.text,
          skill,
          mode,
          ...reply.contextId === undefined ? {} : { contextId: reply.contextId },
          ...reply.taskId === undefined ? {} : { taskId: reply.taskId },
          ...reply.state === undefined ? {} : { state: reply.state },
        }
      }
      const metadata = {
        ...args.skill === undefined ? {} : { skill: args.skill },
        ...args.workspace === undefined ? {} : { workspace: args.workspace },
      }
      const reply = await ctx.a2a.send({
        peer: args.peer,
        text: args.message,
        ...args.contextId === undefined ? {} : { contextId: args.contextId },
        ...args.taskId === undefined ? {} : { taskId: args.taskId },
        ...Object.keys(metadata).length === 0 ? {} : { metadata },
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
      title: `Message A2A peer ${args.peer}${args.skill === undefined ? '' : ` (${args.skill})`}`,
      kind: 'other',
      rawInput: args.message,
    }),
  }))
}
