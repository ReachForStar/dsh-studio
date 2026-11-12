/**
 * OpenAPI document predicates and local `$ref` resolution shared by planning
 * and schema conversion.
 * @module @deepseek-ai/dsh-openapi-tools/document
 */

/** HTTP methods an OpenAPI path item may declare as operations. */
export const OPERATION_METHODS: ReadonlySet<string> = new Set([
  'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace',
])

/** Whether a value is a JSON object (not an array or `null`). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an own property so spec-controlled keys never resolve inherited members. */
export function own(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** A non-empty string, or `undefined` for every other value. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Resolve one JSON pointer fragment (`#/a/b`) against the document root. */
export function resolvePointer(document: Record<string, unknown>, ref: string): unknown {
  return ref
    .slice(2)
    .split('/')
    .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((node, segment) => (isRecord(node) ? own(node, segment) : undefined), document)
}

/**
 * Follow a chain of local `$ref` links.
 * @param document - document root every `#/` pointer resolves against.
 * @param value - candidate node.
 * @returns the last resolved node, or the original value when it carries no resolvable local reference.
 */
export function resolveReference(document: Record<string, unknown>, value: unknown): unknown {
  const seen = new Set<string>()
  let current = value
  for (;;) {
    if (!isRecord(current)) return current
    const ref = nonEmptyString(own(current, '$ref'))
    if (ref === undefined || !ref.startsWith('#/') || seen.has(ref)) return current
    const target = resolvePointer(document, ref)
    if (target === undefined) return current
    seen.add(ref)
    current = target
  }
}
