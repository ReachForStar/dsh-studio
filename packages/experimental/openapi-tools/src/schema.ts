/**
 * Conversion from JSON Schema as written in an OpenAPI 3.x document into the
 * harness value-schema DSL. Constructs the DSL cannot express raise
 * {@link UnsupportedSchemaError}, which the planner turns into a skipped
 * operation instead of a silently incomplete tool.
 * @module @deepseek-ai/dsh-openapi-tools/schema
 */

import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { isRecord, nonEmptyString, own, resolvePointer } from './document.ts'

/** A document construct the value-schema DSL cannot express. */
export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedSchemaError'
  }
}

/** Scalar JSON types the DSL declares directly. */
type ScalarType = 'string' | 'number' | 'integer' | 'boolean' | 'null'

/** Compositions with no DSL equivalent; their presence skips the operation. */
const UNSUPPORTED_COMPOSITIONS = ['allOf', 'anyOf', 'not'] as const

/** The `null` branch reused by nullable and union conversions. */
const NULL_SCHEMA: ValueSchemaSpec = { type: 'null' }

/**
 * Convert one OpenAPI schema node.
 * @param document - document root used to resolve local `$ref` values.
 * @param node - schema node as written in the document.
 * @param label - document location named in an unsupported-construct message.
 * @param inheritedDescription - description from a referencing node, used when the target declares none.
 * @returns the DSL schema for the node.
 * @throws UnsupportedSchemaError when the node uses a construct the DSL cannot express.
 */
export function convertSchema(
  document: Record<string, unknown>,
  node: unknown,
  label: string,
  inheritedDescription?: string,
): ValueSchemaSpec {
  return convertNode(document, node, label, new Set(), inheritedDescription)
}

function convertNode(
  document: Record<string, unknown>,
  node: unknown,
  label: string,
  references: ReadonlySet<string>,
  inheritedDescription?: string,
): ValueSchemaSpec {
  if (!isRecord(node)) throw new UnsupportedSchemaError(`${label} is not a schema object`)
  const reference = nonEmptyString(own(node, '$ref'))
  if (reference !== undefined) {
    if (!reference.startsWith('#/')) {
      throw new UnsupportedSchemaError(`${label} uses external $ref "${reference}"`)
    }
    // A recursive schema has no finite DSL shape; it keeps working as raw JSON.
    if (references.has(reference)) return { type: 'json', description: 'Recursive schema, passed through as raw JSON.' }
    const target = resolvePointer(document, reference)
    if (target === undefined) throw new UnsupportedSchemaError(`${label} references missing "${reference}"`)
    return convertNode(
      document,
      target,
      label,
      new Set([...references, reference]),
      nonEmptyString(own(node, 'description')) ?? inheritedDescription,
    )
  }
  const description = nonEmptyString(own(node, 'description')) ?? inheritedDescription
  for (const keyword of UNSUPPORTED_COMPOSITIONS) {
    if (own(node, keyword) !== undefined) {
      throw new UnsupportedSchemaError(`${label} uses unsupported ${keyword} composition`)
    }
  }
  if (own(node, 'prefixItems') !== undefined) throw new UnsupportedSchemaError(`${label} uses unsupported tuple items`)
  const nullable = own(node, 'nullable') === true

  const oneOf = own(node, 'oneOf')
  if (oneOf !== undefined) {
    if (!Array.isArray(oneOf) || oneOf.length < 2) {
      throw new UnsupportedSchemaError(`${label}.oneOf must list at least two schemas`)
    }
    const branches = oneOf.map((branch, index) => convertNode(document, branch, `${label}.oneOf[${index}]`, references))
    return unionNode(nullable ? [...branches, NULL_SCHEMA] : branches, description)
  }

  const type = own(node, 'type')
  if (Array.isArray(type)) {
    const names = type.filter((entry): entry is string => typeof entry === 'string')
    if (names.length !== type.length || names.length === 0) {
      throw new UnsupportedSchemaError(`${label}.type must list type names`)
    }
    const branches = [...new Set(names)].map((name, index) =>
      convertNode(document, { ...node, type: name, nullable: false }, `${label}.type[${index}]`, references))
    return unionNode(nullable ? [...branches, NULL_SCHEMA] : branches, description)
  }
  if (type !== undefined && typeof type !== 'string') {
    throw new UnsupportedSchemaError(`${label}.type must be a string or an array of strings`)
  }

  const converted = withoutType(document, node, label, references, type, description)
  if (!nullable) return converted
  if ('type' in converted && converted.type === 'json') return converted
  return unionNode('oneOf' in converted ? [...converted.oneOf, NULL_SCHEMA] : [converted, NULL_SCHEMA], description)
}

/** Convert a node once its declared type is known, or infer one from its keywords. */
function withoutType(
  document: Record<string, unknown>,
  node: Record<string, unknown>,
  label: string,
  references: ReadonlySet<string>,
  type: string | undefined,
  description: string | undefined,
): ValueSchemaSpec {
  const resolved = type ?? inferredType(node)
  if (resolved === undefined) return withDescription({ type: 'json' }, description)
  if (resolved === 'object') return objectNode(document, node, label, references, description)
  if (resolved === 'array') return arrayNode(document, node, label, references, description)
  if (!isScalarType(resolved)) {
    throw new UnsupportedSchemaError(`${label}.type "${resolved}" is not supported`)
  }
  return scalarNode(resolved, node, label, description)
}

/** Whether a type name is a JSON scalar the DSL declares. */
function isScalarType(value: string): value is ScalarType {
  return value === 'string' || value === 'number' || value === 'integer' || value === 'boolean' || value === 'null'
}

/** Infer a type for a schema that omits `type`. */
function inferredType(node: Record<string, unknown>): string | undefined {
  if (own(node, 'properties') !== undefined || own(node, 'additionalProperties') !== undefined) return 'object'
  if (own(node, 'items') !== undefined) return 'array'
  const values = own(node, 'enum')
  if (Array.isArray(values) && values.length > 0) return inferredScalarType(values)
  const constant = own(node, 'const')
  return constant === undefined ? undefined : inferredScalarType([constant])
}

/** The one scalar type shared by every value, or `undefined` when they differ. */
function inferredScalarType(values: readonly unknown[]): ScalarType | undefined {
  const kinds = new Set(values.map(value => (value === null ? 'null' : typeof value)))
  const [kind] = kinds
  if (kinds.size !== 1 || kind === undefined) return undefined
  if (kind === 'string' || kind === 'boolean' || kind === 'null') return kind
  if (kind === 'number') return values.every(value => Number.isInteger(value)) ? 'integer' : 'number'
  return undefined
}

/** Convert an object schema; `readOnly` members never reach a request tool. */
function objectNode(
  document: Record<string, unknown>,
  node: Record<string, unknown>,
  label: string,
  references: ReadonlySet<string>,
  description: string | undefined,
): ValueSchemaSpec {
  const declared = own(node, 'properties')
  if (declared !== undefined && !isRecord(declared)) {
    throw new UnsupportedSchemaError(`${label}.properties is not an object`)
  }
  const requiredNames = new Set(
    Array.isArray(own(node, 'required'))
      ? (own(node, 'required') as unknown[]).filter((name): name is string => typeof name === 'string')
      : [],
  )
  const properties: ParameterSchemaSpec = {}
  for (const [name, property] of Object.entries(isRecord(declared) ? declared : {})) {
    if (isRecord(property) && own(property, 'readOnly') === true) continue
    const converted = convertNode(document, property, `${label}.properties.${name}`, references)
    properties[name] = requiredNames.has(name) ? { ...converted, required: true } : converted
  }
  const additionalProperties = own(node, 'additionalProperties') !== false
  return withDescription({ type: 'object', properties, additionalProperties }, description)
}

/** Convert an array schema. */
function arrayNode(
  document: Record<string, unknown>,
  node: Record<string, unknown>,
  label: string,
  references: ReadonlySet<string>,
  description: string | undefined,
): ValueSchemaSpec {
  const items = own(node, 'items')
  if (Array.isArray(items)) throw new UnsupportedSchemaError(`${label}.items is a tuple, which is not supported`)
  return withDescription(
    items === undefined
      ? { type: 'array' }
      : { type: 'array', items: convertNode(document, items, `${label}.items`, references) },
    description,
  )
}

/** Convert one scalar node, carrying only enum and const constraints the DSL supports. */
function scalarNode(
  type: ScalarType,
  node: Record<string, unknown>,
  label: string,
  description: string | undefined,
): ValueSchemaSpec {
  const values = own(node, 'enum')
  const constant = own(node, 'const')
  switch (type) {
    case 'string':
      return withDescription({
        type: 'string',
        ...enumField(values, label, 'string', isString),
        ...constField(constant, label, 'string', isString),
      }, description)
    case 'number':
      return withDescription({
        type: 'number',
        ...enumField(values, label, 'number', isFiniteNumber),
        ...constField(constant, label, 'number', isFiniteNumber),
      }, description)
    case 'integer':
      return withDescription({
        type: 'integer',
        ...enumField(values, label, 'integer', isInteger),
        ...constField(constant, label, 'integer', isInteger),
      }, description)
    case 'boolean':
      return withDescription({
        type: 'boolean',
        ...enumField(values, label, 'boolean', isBoolean),
        ...constField(constant, label, 'boolean', isBoolean),
      }, description)
    case 'null':
      return withDescription({
        type: 'null',
        ...enumField(values, label, 'null', isNull),
        ...constField(constant, label, 'null', isNull),
      }, description)
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isNull(value: unknown): value is null {
  return value === null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value)
}

/** Build the `enum` field when the document declares a matching non-empty list. */
function enumField<T>(
  values: unknown,
  label: string,
  typeName: string,
  matches: (value: unknown) => value is T,
): { enum?: readonly T[] } {
  if (values === undefined) return {}
  if (!Array.isArray(values) || values.length === 0) {
    throw new UnsupportedSchemaError(`${label}.enum must be a non-empty array`)
  }
  const matched = values.filter(matches)
  if (matched.length !== values.length) {
    throw new UnsupportedSchemaError(`${label}.enum contains a value that is not ${typeName}`)
  }
  return { enum: matched }
}

/** Build the `const` field when the document declares a matching value. */
function constField<T>(
  value: unknown,
  label: string,
  typeName: string,
  matches: (value: unknown) => value is T,
): { const?: T } {
  if (value === undefined) return {}
  if (!matches(value)) throw new UnsupportedSchemaError(`${label}.const is not ${typeName}`)
  return { const: value }
}

/** Build an exact-one union, rejecting a single branch that has no union meaning. */
function unionNode(branches: readonly ValueSchemaSpec[], description: string | undefined): ValueSchemaSpec {
  const [first, second, ...rest] = branches
  if (first === undefined || second === undefined) {
    throw new UnsupportedSchemaError('a union needs at least two distinct branches')
  }
  return withDescription({ oneOf: [first, second, ...rest] }, description)
}

/** Copy a description onto a node without mutating the converted value. */
function withDescription(spec: ValueSchemaSpec, description: string | undefined): ValueSchemaSpec {
  return description === undefined ? spec : { ...spec, description }
}
