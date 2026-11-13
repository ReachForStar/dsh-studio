/**
 * Enforce intra-package domain layering inside `packages/client/*\/src/client/`.
 * verify-module-graph covers package-level edges; this gate covers the
 * directory level: domain directories may import `contract/` and never each
 * other, and only the assembly point (`apply.ts` / `index.ts`) may import
 * across domains.
 *
 * Layer model (lower may not import higher):
 *   0  contract/            shared contract API (types + slot declarations)
 *   1  <domain>/ + service  domain implementations (skeleton/, chat/, ...)
 *   2  apply.ts, index.ts   assembly point and re-export shell
 *
 * A package whose real layering needs more than one shared layer, or a
 * directed dependency between two domains, declares it in
 * `src/client/layers.json`:
 *
 *   { "shared": ["document"], "edges": { "docx": ["office"] } }
 *
 * `shared` directories are importable from every domain and top-level file but
 * may themselves import only `contract/` or another shared directory. `edges`
 * names one-way dependencies; the declared graph must stay acyclic, an
 * undeclared edge still fails, and a declaration naming an unknown directory
 * or file fails. Resources (stylesheets, images, fonts) carry no domain API and
 * are ignored.
 *
 * Run directly:
 *   pnpm exec tsx scripts/verify-client-domain-graph.ts
 */

import { existsSync, globSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const CLIENT_DIR = join(root, 'packages/client')

/** Directory names treated as the shared contract layer (importable by all). */
const CONTRACT_DIRS = new Set(['contract'])
/** Top-level client files allowed to import across domains (assembly layer). */
const ASSEMBLY_FILES = new Set(['apply.ts', 'index.ts', 'index.tsx'])
/**
 * Resource imports carry no domain API: a stylesheet module, image, or font
 * belongs to the component that consumes it, so layering does not apply.
 */
const RESOURCE_IMPORT = /\.(?:css|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf|mp4|webm|mp3|wav)$/i

/** One package's declared extra layering. */
interface Layers {
  /** Directories importable from every domain and top-level file. */
  readonly shared: ReadonlySet<string>
  /** Allowed one-way imports, keyed by domain directory or top-level file name. */
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>
}

interface Violation { file: string; imported: string; reason: string }

/** Read and validate one package's `layers.json`; absence means no declaration. */
function readLayers(clientDir: string): Layers {
  const path = join(clientDir, 'layers.json')
  if (!existsSync(path)) return { shared: new Set(), edges: new Map() }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { shared?: unknown; edges?: unknown }
  const shared = new Set<string>()
  if (Array.isArray(parsed.shared)) {
    for (const name of parsed.shared) {
      if (typeof name !== 'string') throw new TypeError(`${path}: shared entries must be directory names`)
      shared.add(name)
    }
  }
  const edges = new Map<string, ReadonlySet<string>>()
  if (parsed.edges !== undefined) {
    if (typeof parsed.edges !== 'object' || parsed.edges === null) throw new TypeError(`${path}: edges must be an object`)
    for (const [from, targets] of Object.entries(parsed.edges)) {
      if (!Array.isArray(targets) || targets.some(target => typeof target !== 'string')) {
        throw new TypeError(`${path}: edges.${from} must be an array of directory or file names`)
      }
      edges.set(from, new Set(targets as string[]))
    }
  }
  return { shared, edges }
}

/** Recursively list .ts/.tsx files under dir (relative paths). */
function listSources(dir: string): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: dir })
    .map(rel => rel.split(sep).join('/'))
    .filter(rel => !/\.legacy\./.test(rel.slice(rel.lastIndexOf('/') + 1)))
    .sort()
}

/** First path segment of a client-relative file, or '' for top-level files. */
function domainOf(rel: string): string {
  const ix = rel.indexOf('/')
  return ix === -1 ? '' : rel.slice(0, ix)
}

/**
 * Resolve one relative import to a client-directory-relative path.
 * @param file - Importing file relative to `src/client`.
 * @param specifier - Relative module specifier from that file.
 * @returns Normalized path, preserving leading `..` segments outside `src/client`.
 */
export function resolveClientImport(file: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(file), specifier))
}

/** Whether a declared edge graph stays acyclic; returns the first cycle it finds. */
function declaredCycle(edges: ReadonlyMap<string, ReadonlySet<string>>): string[] | undefined {
  const visiting = new Set<string>()
  const done = new Set<string>()
  const walk = (node: string, path: string[]): string[] | undefined => {
    if (done.has(node)) return undefined
    if (visiting.has(node)) return [...path, node]
    visiting.add(node)
    for (const next of edges.get(node) ?? []) {
      const cycle = walk(next, [...path, node])
      if (cycle !== undefined) return cycle
    }
    visiting.delete(node)
    done.add(node)
    return undefined
  }
  for (const node of edges.keys()) {
    const cycle = walk(node, [])
    if (cycle !== undefined) return cycle
  }
  return undefined
}

function checkPackage(pkgName: string, clientDir: string): Violation[] {
  const layers = readLayers(clientDir)
  const shared = new Set([...CONTRACT_DIRS, ...layers.shared])
  const violations: Violation[] = []
  const files = listSources(clientDir)
  const dirs = new Set(files.map(rel => domainOf(rel)).filter(domain => domain !== ''))

  // A declaration that names nothing real would silently permit nothing; a
  // cycle would make the declared order meaningless.
  for (const name of layers.shared) {
    if (!dirs.has(name)) {
      violations.push({ file: `${pkgName}/src/client/layers.json`, imported: name, reason: `shared layer "${name}" names no client directory` })
    }
  }
  for (const [from, targets] of layers.edges) {
    if (from !== '' && !dirs.has(from) && !files.includes(from)) {
      violations.push({ file: `${pkgName}/src/client/layers.json`, imported: from, reason: `edge source "${from}" names no client directory or file` })
    }
    if (shared.has(from)) {
      violations.push({ file: `${pkgName}/src/client/layers.json`, imported: from, reason: `shared layer "${from}" may not declare outgoing edges` })
    }
    for (const target of targets) {
      if (!dirs.has(target)) {
        violations.push({ file: `${pkgName}/src/client/layers.json`, imported: target, reason: `edge target "${target}" names no client directory` })
      }
      if (shared.has(target)) {
        violations.push({ file: `${pkgName}/src/client/layers.json`, imported: target, reason: `edge target "${target}" is already a shared layer` })
      }
    }
  }
  const cycle = declaredCycle(layers.edges)
  if (cycle !== undefined) {
    violations.push({ file: `${pkgName}/src/client/layers.json`, imported: cycle.join(' -> '), reason: 'declared edges must not form a cycle' })
  }

  for (const rel of files) {
    const fromDomain = domainOf(rel)
    const isAssembly = fromDomain === '' && ASSEMBLY_FILES.has(rel)
    if (isAssembly) continue
    const source = readFileSync(join(clientDir, rel), 'utf8')
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = match[1]
      if (spec === undefined || RESOURCE_IMPORT.test(spec)) continue
      const target = resolveClientImport(rel, spec)
      if (target === '..' || target.startsWith('../')) continue // package-level rules govern
      const toDomain = domainOf(target)
      if (toDomain === '' || shared.has(toDomain)) continue // top-level shared file or shared layer
      if (fromDomain === toDomain) continue // inside one domain
      const sourceKey = fromDomain === '' ? rel : fromDomain
      if (layers.edges.get(sourceKey)?.has(toDomain) === true) continue // declared one-way dependency
      violations.push({
        file: `${pkgName}/src/client/${rel}`,
        imported: spec,
        reason: fromDomain === ''
          ? `top-level non-assembly file imports domain "${toDomain}" (only apply/index may assemble)`
          : shared.has(fromDomain)
            ? `shared layer "${fromDomain}" imports domain "${toDomain}"`
            : `domain "${fromDomain}" imports sibling domain "${toDomain}" (route shared API through contract/)`,
      })
    }
  }
  return violations
}

function main(): void {
  const violations: Violation[] = []
  for (const pkg of readdirSync(CLIENT_DIR)) {
    const clientDir = join(CLIENT_DIR, pkg, 'src/client')
    try {
      if (!statSync(clientDir).isDirectory()) continue
    } catch {
      // No client half in this package — nothing to layer-check.
      continue
    }
    violations.push(...checkPackage(pkg, clientDir))
  }

  if (violations.length > 0) {
    console.error(`verify-client-domain-graph: ${violations.length} violation(s):`)
    for (const v of violations) console.error(`  ${v.file} -> ${v.imported}\n    ${v.reason}`)
    process.exitCode = 1
    return
  }
  console.log('verify-client-domain-graph: client domain layering clean.')
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
