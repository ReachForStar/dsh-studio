import { describe, expect, it } from 'vitest'
import { buildAgentCard, DEFAULT_SKILL } from '../src/card.ts'

const BASE = {
  name: 'dsh',
  description: 'sessions',
  version: '0.1.0',
  url: 'http://127.0.0.1:9310/',
  skills: [DEFAULT_SKILL],
}

describe('buildAgentCard', () => {
  it('只公布 JSONRPC 绑定与流式能力', () => {
    const card = buildAgentCard({ ...BASE, authenticated: false })
    expect(card).toMatchObject({
      name: 'dsh',
      description: 'sessions',
      version: '0.1.0',
      supportedInterfaces: [{ url: 'http://127.0.0.1:9310/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [DEFAULT_SKILL],
    })
    expect(card.securitySchemes).toBeUndefined()
    expect(card.securityRequirements).toBeUndefined()
    expect(card.documentationUrl).toBeUndefined()
  })

  it('需要凭据时声明 apiKey 方案与要求', () => {
    const card = buildAgentCard({ ...BASE, authenticated: true, documentationUrl: 'https://example/docs' })
    expect(card.securitySchemes).toEqual({ apiKey: { apiKeySecurityScheme: { location: 'header', name: 'X-Api-Key' } } })
    expect(card.securityRequirements).toEqual([{ schemes: { apiKey: { list: [] } } }])
    expect(card.documentationUrl).toBe('https://example/docs')
  })
})

describe('DEFAULT_SKILL', () => {
  it('每个字段都在，便于作为配置默认值', () => {
    expect(Object.values(DEFAULT_SKILL).every(value => value !== undefined)).toBe(true)
    expect(DEFAULT_SKILL.id).toBe('default')
  })
})
