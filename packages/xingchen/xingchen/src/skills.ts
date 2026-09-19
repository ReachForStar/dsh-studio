/**
 * Bundled Xingchen skills: `git` (read history and find the introducing
 * commit), `run` (execute a reproduction or focused test and report the real
 * result), and `log` (parse a log or stack trace into the evidence that names
 * the failure). The four roles call them through the ordinary skill catalog,
 * so `$git`, `$run`, and `$log` work in the composer and the model loads them
 * by name.
 *
 * @module @reachforstar/dsh-xingchen/skills
 */

import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

/** Bundled skill directory names, in catalog order. */
const SKILL_NAMES = ['git', 'run', 'log'] as const

/** Provider name this package registers in the skill registry. */
export const PROVIDER_NAME = 'dsh-xingchen'

/** Where the bundled skill documents live. */
export interface Config {
  /** Absolute assets directory holding the three skill folders; defaults to the packaged assets. */
  assetRoot?: string
}

/** Validated resource configuration. */
export const Config: z<Config> = z.object({ assetRoot: z.string().min(1) })

/** Cordis plugin identity. */
export const name = 'xingchen-skills'
/** Registry this provider registers into. */
export const inject = ['skills']

/**
 * Split one skill document into its frontmatter and body.
 * @param raw - complete `SKILL.md` text.
 * @param path - the document's path, named in diagnostics.
 * @returns the declared description and the body without frontmatter.
 */
function parseSkill(raw: string, path: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`xingchen-skills: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description
    : undefined
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`xingchen-skills: ${path} has no description`)
  }
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

/**
 * Register the three bundled skills with the skill registry.
 * @param ctx - context carrying the skill registry.
 * @param config - optional external assets directory for packaged applications.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const assetRoot = config.assetRoot ?? fileURLToPath(new URL('../skills/', import.meta.url))
  if (!isAbsolute(assetRoot)) throw new Error('xingchen-skills: assetRoot must be an absolute directory')
  const candidates: SkillCandidate[] = SKILL_NAMES.map((skillName) => {
    const directory = join(assetRoot, skillName)
    const path = join(directory, 'SKILL.md')
    if (!statSync(path).isFile()) throw new Error(`xingchen-skills: ${path} is missing`)
    const { description } = parseSkill(readFileSync(path, 'utf8'), path)
    return {
      name: skillName,
      description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER_NAME,
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory },
      locator: path,
    }
  })
  const provider: SkillProvider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve(candidates),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(locator as string, { encoding: 'utf8', signal: options.signal })
      return { ...summary, content: parseSkill(raw, locator as string).content }
    },
  }
  ctx.skills.registerProvider(() => provider)
}
