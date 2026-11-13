/**
 * Static `tools.<path>` extraction for one PTC program. The approval seam uses
 * it to classify a `run_code` escalation by the tools its source names, so an
 * unattended allow rule can name those tools. The scan fails closed: dynamic
 * bracket access, aliasing `tools`, any shadowing declaration named `tools`,
 * an unparseable program, or a program that redeclares a path yields no
 * resources, so a rule cannot be widened by source it cannot see.
 * @module @deepseek-ai/dsh-tool-executor-ptc/src/scan
 */

import { stripTypeScriptTypes } from 'node:module'
import { parse } from 'acorn'
import type { AnyNode, Program } from 'acorn'

/** One scan outcome; `tools` is empty whenever `problem` is set. */
export interface StaticToolScan {
  /** Tool paths referenced through a static `tools.` chain, in first-seen order. */
  readonly tools: readonly string[]
  /** Why the scan produced no resources, when it could not prove a static set. */
  readonly problem?: string
}

/** The tool object every PTC program receives. */
const TOOLS_IDENTIFIER = 'tools'

/**
 * Extract the statically referenced tool paths of one program body.
 * @param code - the program source exactly as the model wrote it.
 * @returns the static paths, or an empty list with the reason.
 */
export function scanToolReferences(code: string): StaticToolScan {
  if (code.trim().length === 0) return { tools: [] }
  let source: string
  try {
    source = quietTypeStripping(() => stripTypeScriptTypes(code, { mode: 'strip' }))
  } catch (error: unknown) {
    return { tools: [], problem: `the program does not strip as TypeScript: ${messageOf(error)}` }
  }
  let program: Program
  try {
    program = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    })
  } catch (error: unknown) {
    return { tools: [], problem: `the program does not parse: ${messageOf(error)}` }
  }
  if (declaresTools(program)) return { tools: [], problem: 'the program declares its own `tools` binding' }
  const found = new Map<string, number>()
  interface Frame { readonly node: AnyNode; readonly parent?: AnyNode }
  const stack: Frame[] = [{ node: program }]
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const node = frame.node
    if (node.type === 'Identifier' && node.name === TOOLS_IDENTIFIER && !isToolObjectOf(frame.parent, node)) {
      // A bare `tools` reference (aliasing, passing it on) hides the real calls.
      return { tools: [], problem: 'the program references `tools` without a static path' }
    }
    if (node.type === 'MemberExpression') {
      const chain = staticChain(node)
      switch (chain.kind) {
        case 'dynamic':
          if (containsToolsIdentifier(node)) return { tools: [], problem: 'the program reaches tools through a dynamic expression' }
          break
        case 'tools':
          if (!found.has(chain.path)) found.set(chain.path, node.start)
          break
        case 'other':
          break
      }
    }
    forEachChild(node, child => stack.push({ node: child, parent: node }))
  }
  // A longer chain supersedes its prefixes: `tools.a.b` is not also tool `a`.
  const paths = [...found.keys()]
  const kept = paths.filter(path => !paths.some(other => other !== path && other.startsWith(`${path}.`)))
  return { tools: kept.sort((left, right) => (found.get(left) as number) - (found.get(right) as number)) }
}

/** A static tool chain, a dynamic access through some object, or a chain of another object. */
type Chain = { readonly kind: 'tools'; readonly path: string } | { readonly kind: 'dynamic' } | { readonly kind: 'other' }

/** Read one static `tools.a["b"]` chain. */
function staticChain(node: AnyNode): Chain {
  const segments: string[] = []
  let current: AnyNode = node
  while (current.type === 'MemberExpression') {
    if (!current.computed && current.property.type === 'Identifier') {
      segments.unshift(current.property.name)
    } else if (current.computed && current.property.type === 'Literal' && typeof current.property.value === 'string') {
      segments.unshift(current.property.value)
    } else {
      return { kind: 'dynamic' }
    }
    current = current.object
  }
  if (current.type !== 'Identifier' || current.name !== TOOLS_IDENTIFIER) return { kind: 'other' }
  return { kind: 'tools', path: segments.join('.') }
}

/** Whether one expression's subtree mentions the `tools` identifier anywhere. */
function containsToolsIdentifier(node: AnyNode): boolean {
  let found = false
  walk(node, (child) => {
    if (child.type === 'Identifier' && child.name === TOOLS_IDENTIFIER) found = true
  })
  return found
}

/** Whether the program declares any binding named `tools`, which would make the scan ambiguous. */
function declaresTools(program: Program): boolean {
  let declared = false
  walk(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === TOOLS_IDENTIFIER) declared = true
    if (node.type === 'ClassDeclaration' && node.id?.name === TOOLS_IDENTIFIER) declared = true
    if (node.type === 'CatchClause' && node.param?.type === 'Identifier' && node.param.name === TOOLS_IDENTIFIER) declared = true
    if (node.type === 'ImportDeclaration' && node.specifiers.some(specifier => specifier.local.name === TOOLS_IDENTIFIER)) declared = true
    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')
      && node.params.some(parameter => parameter.type === 'Identifier' && parameter.name === TOOLS_IDENTIFIER)) declared = true
  })
  return declared
}

/** Whether this identifier is the `tools` object of a member expression. */
function isToolObjectOf(parent: AnyNode | undefined, node: AnyNode): boolean {
  return parent?.type === 'MemberExpression' && parent.object === node
}

/** Visit every AST child of one node. */
function forEachChild(node: AnyNode, visit: (child: AnyNode) => void): void {
  const record = node as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range' || key === 'parent') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        /* v8 ignore next -- acorn child arrays hold nodes or excluded primitives. */
        if (isNode(item)) visit(item)
      }
      continue
    }
    if (isNode(value)) visit(value)
  }
}

/** Run one complete AST visit. */
function walk(node: AnyNode, visit: (node: AnyNode) => void): void {
  const stack: AnyNode[] = [node]
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    visit(current)
    forEachChild(current, child => stack.push(child))
  }
}

/** Narrow one AST child value. */
function isNode(value: unknown): value is AnyNode {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
}

/**
 * Run one synchronous call without printing Node's experimental type-stripping
 * warning; the runtime's own helper covers the same warning in the child.
 */
function quietTypeStripping<T>(call: () => T): T {
  // oxlint-disable-next-line typescript/unbound-method -- restored unchanged after the call.
  const emitWarning = process.emitWarning
  process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    /* v8 ignore next -- the only warning type stripping emits is a string. */
    const message = typeof warning === 'string' ? warning : warning.message
    /* v8 ignore next 3 -- synchronous type stripping emits only its own warning. */
    if (!message.startsWith('stripTypeScriptTypes is an experimental feature')) {
      Reflect.apply(emitWarning, process, [warning, ...rest])
    }
  }
  try {
    return call()
  } finally {
    process.emitWarning = emitWarning
  }
}

/** Read a thrown value's message without echoing a stack. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- type stripping and acorn throw Error instances. */
  return error instanceof Error ? error.message : String(error)
}
