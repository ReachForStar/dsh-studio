import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, buildTools, credentialName } from '../src/index.ts'
import { buildOperations, loadDocument } from '../src/spec.ts'
import type { OperationPlan } from '../src/spec.ts'

const PETS = fileURLToPath(new URL('./fixtures/pets.yaml', import.meta.url))
const STORE = fileURLToPath(new URL('./fixtures/store.json', import.meta.url))
const SWAGGER = fileURLToPath(new URL('./fixtures/swagger.yaml', import.meta.url))

function operation(operations: readonly OperationPlan[], name: string): OperationPlan {
  const plan = operations.find(candidate => candidate.name === name)
  if (plan === undefined) throw new Error(`missing planned operation ${name}`)
  return plan
}

describe('loadDocument', () => {
  it('reads a YAML document', async () => {
    await expect(loadDocument(PETS)).resolves.toMatchObject({ openapi: '3.1.0' })
  })

  it('reads a JSON document', async () => {
    await expect(loadDocument(STORE)).resolves.toMatchObject({ openapi: '3.0.3' })
  })

  it('rejects a non-OpenAPI-3 document', async () => {
    await expect(loadDocument(SWAGGER)).rejects.toMatchObject({ code: 'OPENAPI_SPEC_INVALID' })
  })

  it('rejects a missing file', async () => {
    await expect(loadDocument(fileURLToPath(new URL('./fixtures/missing.yaml', import.meta.url))))
      .rejects.toBeInstanceOf(HarnessError)
  })
})

describe('buildOperations', () => {
  it('names operations from operationId and keeps duplicates stable', async () => {
    const result = buildOperations(await loadDocument(PETS), { descriptionMaxLength: 1_024 })
    expect(result.operations.map(plan => plan.name)).toEqual([
      'listPets',
      'createPet',
      'getPet',
      'deletePetsByPetId',
      'collideOp',
      'listPets_2',
    ])
  })

  it('merges path, query, and header parameters into one schema', async () => {
    const result = buildOperations(await loadDocument(PETS), { descriptionMaxLength: 1_024 })
    const getPet = operation(result.operations, 'getPet')
    expect(getPet.parameters).toMatchObject({
      petId: { type: 'string', required: true },
      verbose: { type: 'boolean' },
      'X-Request-Id': { type: 'string' },
    })
    expect(getPet.parameters).not.toHaveProperty('Accept')
    expect(getPet.fields.map(field => field.location)).toEqual(['path', 'query', 'header'])
  })

  it('qualifies same-named parameters by location', async () => {
    const result = buildOperations(await loadDocument(PETS), { descriptionMaxLength: 1_024 })
    const collide = operation(result.operations, 'collideOp')
    expect(Object.keys(collide.parameters)).toEqual(['query_value', 'header_value'])
  })

  it('converts a JSON request body and drops readOnly members', async () => {
    const result = buildOperations(await loadDocument(PETS), { descriptionMaxLength: 1_024 })
    const createPet = operation(result.operations, 'createPet')
    expect(createPet.parameters.body).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        name: { type: 'string', required: true, description: 'Pet name' },
        age: { type: 'integer' },
      },
    })
    expect(createPet.parameters.body).not.toHaveProperty('properties.id')
    expect(createPet.body).toEqual({ inputName: 'body', required: true, mediaType: 'application/json' })
  })

  it('carries array, object, and enum constraints', async () => {
    const pets = buildOperations(await loadDocument(PETS), { descriptionMaxLength: 1_024 })
    expect(operation(pets.operations, 'listPets').parameters).toMatchObject({
      limit: { type: 'integer', description: 'Maximum number of pets to return.' },
      tags: { type: 'array', items: { type: 'string' } },
      filter: { type: 'object', additionalProperties: false, properties: { color: { type: 'string' } } },
    })
    const store = buildOperations(await loadDocument(STORE), { descriptionMaxLength: 1_024 })
    expect(operation(store.operations, 'getItem').parameters.mode).toMatchObject({
      type: 'string',
      enum: ['short', 'full'],
    })
  })

  it('converts a oneOf body and degrades a recursive schema to raw JSON', async () => {
    const result = buildOperations(await loadDocument(STORE), { descriptionMaxLength: 1_024 })
    expect(operation(result.operations, 'createItem').parameters.body).toMatchObject({
      oneOf: [
        { type: 'object', properties: { name: { type: 'string', required: true } } },
        { type: 'string' },
      ],
    })
    expect(operation(result.operations, 'createTree').parameters.body).toMatchObject({
      type: 'object',
      properties: {
        label: { type: 'string' },
        children: { type: 'array', items: { type: 'json' } },
      },
    })
  })

  it('skips unsupported constructs with a reason', async () => {
    const result = buildOperations(await loadDocument(PETS), { descriptionMaxLength: 1_024 })
    expect(result.skipped.map(item => `${item.method} ${item.path}`)).toEqual([
      'POST /upload',
      'POST /form',
      'POST /composed',
      'GET /cookies',
      'GET /delimited',
      'POST /callback',
      'WEBHOOK petCreated',
    ])
    expect(result.skipped.map(item => item.reason)).toEqual([
      expect.stringContaining('multipart/form-data'),
      expect.stringContaining('application/x-www-form-urlencoded'),
      expect.stringContaining('allOf'),
      expect.stringContaining('cookie'),
      expect.stringContaining('spaceDelimited'),
      expect.stringContaining('callbacks'),
      expect.stringContaining('webhooks'),
    ])
  })

  it('prefers summary and truncates the description', async () => {
    const result = buildOperations(await loadDocument(PETS), { descriptionMaxLength: 20 })
    const getPet = operation(result.operations, 'getPet')
    expect(getPet.description).toHaveLength(20)
    expect(getPet.description.endsWith('…')).toBe(true)
  })

  it('falls back to the transport line when the operation has no summary', async () => {
    const result = buildOperations(await loadDocument(PETS), { descriptionMaxLength: 1_024 })
    expect(operation(result.operations, 'collideOp').description).toBe('GET /collide')
    expect(operation(result.operations, 'getPet').description).toBe('GET /pets/{petId}\n\nFetch one pet')
  })

  it('honours a baseUrl override', async () => {
    const result = buildOperations(await loadDocument(PETS), {
      baseUrl: 'http://localhost:8080/api/',
      descriptionMaxLength: 1_024,
    })
    expect(operation(result.operations, 'getPet').url).toBe('http://localhost:8080/api/pets/{petId}')
  })

  it('skips every operation when no absolute server URL is available', () => {
    const result = buildOperations({
      openapi: '3.1.0',
      paths: { '/x': { get: { operationId: 'x', responses: {} } } },
    }, { descriptionMaxLength: 1_024 })
    expect(result.operations).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.method).toBe('GET')
    expect(result.skipped[0]?.path).toBe('/x')
    expect(result.skipped[0]?.reason).toContain('baseUrl')
  })

  it('skips a path template placeholder without a declaration', () => {
    const result = buildOperations({
      openapi: '3.1.0',
      servers: [{ url: 'https://example.test' }],
      paths: { '/x/{id}': { get: { operationId: 'x', responses: {} } } },
    }, { descriptionMaxLength: 1_024 })
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.method).toBe('GET')
    expect(result.skipped[0]?.path).toBe('/x/{id}')
    expect(result.skipped[0]?.reason).toContain('"id"')
  })
})

describe('buildTools', () => {
  it('builds one tool per planned operation', async () => {
    const { tools } = buildTools(await loadDocument(STORE), { descriptionMaxLength: 1_024 })
    expect(tools.map(tool => tool.name)).toEqual(['getItem', 'createItem', 'createTree'])
  })
})

describe('apply', () => {
  function context(): { ctx: Context; registered: ToolDefinition[]; warnings: string[] } {
    const registered: ToolDefinition[] = []
    const warnings: string[] = []
    const ctx = {
      tools: {
        register: (definition: ToolDefinition) => {
          registered.push(definition)
          return () => {}
        },
      },
      logger: { warn: (message: string) => { warnings.push(message) } },
    } as Context
    return { ctx, registered, warnings }
  }

  it('registers the generated tools and logs every skip', async () => {
    const { ctx, registered, warnings } = context()
    await apply(ctx, { spec: PETS })
    expect(registered.map(tool => tool.name)).toEqual([
      'listPets',
      'createPet',
      'getPet',
      'deletePetsByPetId',
      'collideOp',
      'listPets_2',
    ])
    expect(warnings).toHaveLength(7)
    expect(warnings[0]).toContain('openapi-tools: skipped POST /upload')
  })

  it('fails activation when the document cannot be read', async () => {
    const { ctx } = context()
    await expect(apply(ctx, { spec: fileURLToPath(new URL('./fixtures/missing.yaml', import.meta.url)) }))
      .rejects.toBeInstanceOf(HarnessError)
  })
})

describe('credentialName', () => {
  it('accepts both credential-reference forms', () => {
    expect(credentialName('${credential:PET_TOKEN}')).toBe('PET_TOKEN')
    expect(credentialName('PET_TOKEN')).toBe('PET_TOKEN')
  })

  it('rejects a name outside the reference grammar', () => {
    expect(() => credentialName('${credential:not a name}')).toThrow(/credential/)
  })
})
