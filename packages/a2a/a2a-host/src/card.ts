import type { AgentCard, AgentSkill } from '@reachforstar/dsh-a2a'

/** What the card says about this deployment. */
export interface CardConfig {
  /** Agent name peers see. */
  name: string
  /** What the agent does. */
  description: string
  /** Agent version. */
  version: string
  /** Endpoint peers call; the JSON-RPC binding is served there. */
  url: string
  /** Capabilities the agent advertises. */
  skills: AgentSkill[]
  /** Whether calls must carry the configured API key. */
  authenticated: boolean
  /** Documentation URL peers can read. */
  documentationUrl?: string
}

/**
 * The default skill: one dsh Session turn in a working directory. Every field
 * is present so the value also serves as a configuration schema default, where
 * optional fields would otherwise be absent from the parsed type.
 */
export const DEFAULT_SKILL: Required<AgentSkill> = {
  id: 'default',
  name: 'Agent session',
  description: 'Run one turn of a session agent in the deployment working directory',
  tags: ['coding', 'session'],
  examples: [],
  inputModes: [],
  outputModes: [],
}

/**
 * Build the card from deployment facts.
 * @param config - identity, endpoint, skills, and authentication.
 * @returns the card served at `/.well-known/agent-card.json`.
 */
export function buildAgentCard(config: CardConfig): AgentCard {
  return {
    name: config.name,
    description: config.description,
    supportedInterfaces: [{
      url: config.url,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    }],
    version: config.version,
    ...config.documentationUrl === undefined ? {} : { documentationUrl: config.documentationUrl },
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    ...config.authenticated ? {
      securitySchemes: {
        apiKey: { apiKeySecurityScheme: { location: 'header' as const, name: 'X-Api-Key' } },
      },
      securityRequirements: [{ schemes: { apiKey: { list: [] } } }],
    } : {},
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: config.skills,
  }
}
