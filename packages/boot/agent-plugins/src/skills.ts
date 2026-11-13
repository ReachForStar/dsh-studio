/**
 * Agent Plugins v1 skill components: direct-child `skills/<dir>/SKILL.md` files
 * that follow the portable Agent Skills metadata rules. A skill that fails
 * validation is skipped on its own; the remaining skills of the same package
 * stay available.
 * @module @deepseek-ai/dsh-agent-plugins/skills
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseDocument } from 'yaml'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider } from '@deepseek-ai/dsh-skill'
import { resolveContainedOrUnusable } from './paths.ts'

/** Frontmatter block at the start of a portable `SKILL.md` file. */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/** Portable Agent Skills name rule; the name must also equal its directory. */
const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** One package whose skills are published through {@link AgentPluginSkillProvider}. */
export interface AgentPluginSkillSource {
  /** Package directory; every skill must resolve inside it. */
  readonly root: string
}

/** Parsed body of one portable skill file. */
interface ParsedSkill {
  /** Kebab-case skill name declared by the frontmatter. */
  readonly name: string
  /** Routing description declared by the frontmatter. */
  readonly description: string
  /** Markdown body after the frontmatter block. */
  readonly content: string
}

/** Skill locator owned by this provider and handed back by `get()`. */
interface SkillLocator {
  /** Absolute `SKILL.md` path. */
  readonly file: string
  /** Absolute skill directory used as the relative-resource base. */
  readonly directory: string
}

/** Provider that publishes the skills of configured Agent Plugins v1 packages. */
export class AgentPluginSkillProvider implements SkillProvider {
  readonly name = 'agent-plugins'

  constructor(
    private readonly sources: readonly AgentPluginSkillSource[],
    private readonly rank: number,
  ) {}

  /**
   * List every skill found in the configured packages.
   * @param options - lookup options; the signal cancels discovery between packages.
   * @returns candidates in package order; unreadable skills are omitted.
   */
  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    const candidates: SkillCandidate[] = []
    for (const source of this.sources) {
      options.signal?.throwIfAborted()
      for (const locator of await listSkillLocators(source.root)) {
        options.signal?.throwIfAborted()
        const parsed = await readSkill(locator)
        if (parsed === undefined) continue
        candidates.push({
          name: parsed.name,
          description: parsed.description,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: this.name,
          source: 'custom',
          rank: this.rank,
          locator,
          path: locator.file,
          resourceBase: { kind: 'directory', path: locator.directory },
        })
      }
    }
    return candidates
  }

  /**
   * Load the body of one previously listed skill.
   * @param candidate - candidate returned by {@link list}.
   * @param options - lookup options; the signal cancels the read.
   * @returns the full skill, or `undefined` when the file no longer parses.
   */
  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    options.signal?.throwIfAborted()
    const locator = candidate.locator as SkillLocator
    const parsed = await readSkill(locator)
    if (parsed === undefined) return undefined
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      provider: candidate.provider,
      source: candidate.source,
      path: locator.file,
      resourceBase: { kind: 'directory', path: locator.directory },
      content: parsed.content,
    }
  }
}

/**
 * Resolve every portable skill file of one package.
 * @param root - package directory.
 * @returns locators for existing `skills/<dir>/SKILL.md` files; a package
 *   without a `skills` directory yields none.
 * @throws when a skill directory escapes the package root.
 */
async function listSkillLocators(root: string): Promise<SkillLocator[]> {
  const skillsRoot = join(root, 'skills')
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch((error: unknown) => {
    /* v8 ignore else -- Native non-absence directory failures are host-dependent; the absence path is covered. */
    if (isAbsent(error)) return []
    /* v8 ignore next -- Same native error branch as above. */
    throw error
  })
  const locators: SkillLocator[] = []
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    const skillRoot = await resolveContainedOrUnusable(root, join(skillsRoot, entry.name))
    if (skillRoot === undefined) continue
    const file = join(skillRoot, 'SKILL.md')
    if (!(await isFile(file))) continue
    const containedFile = await resolveContainedOrUnusable(root, file)
    if (containedFile !== undefined) locators.push({ file: containedFile, directory: skillRoot })
  }
  return locators
}

/**
 * Read and validate one portable skill file.
 * @param locator - resolved skill paths.
 * @returns the parsed skill, or `undefined` when the file is unreadable or its
 *   frontmatter breaks the portable metadata rules.
 */
async function readSkill(locator: SkillLocator): Promise<ParsedSkill | undefined> {
  const raw = await readFile(locator.file, 'utf8').catch((error: unknown): undefined => {
    /* v8 ignore else -- Native non-absence read failures are host-dependent; the absence path is covered. */
    if (isAbsent(error)) return undefined
    /* v8 ignore next -- Same native error branch as above. */
    throw error
  })
  if (raw === undefined) return undefined
  const match = FRONTMATTER_PATTERN.exec(raw)
  if (match === null) return undefined
  // The capture group of a matched pattern is always present; the assertion states that instead of adding a dead branch.
  const frontmatter = frontmatterOf(match[1] as string)
  if (typeof frontmatter !== 'object' || frontmatter === null) return undefined
  const name = (frontmatter as Record<string, unknown>)['name']
  const description = (frontmatter as Record<string, unknown>)['description']
  if (!isPortableSkillName(name) || name !== basename(locator.directory)) return undefined
  if (typeof description !== 'string' || description === '' || Array.from(description).length > 1024) return undefined
  return { name, description, content: raw.slice(match[0].length).trim() }
}

/** Parse a frontmatter block; a malformed YAML document makes this skill unusable, not the package. */
function frontmatterOf(raw: string): unknown {
  const document = parseDocument(raw)
  if (document.errors.length > 0) return undefined
  return document.toJS()
}

function isPortableSkillName(value: unknown): value is string {
  return typeof value === 'string' && Array.from(value).length <= 64 && SKILL_NAME_PATTERN.test(value)
}

/** An unreadable or absent path is simply not a skill file; discovery continues with its siblings. */
async function isFile(path: string): Promise<boolean> {
  return await stat(path).then(stats => stats.isFile(), () => false)
}

function isAbsent(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
