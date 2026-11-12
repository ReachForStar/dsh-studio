import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentPluginSkillProvider } from '../src/skills.ts'

const created: string[] = []

async function pluginRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-skills-'))
  created.push(dir)
  return dir
}

async function writeSkill(root: string, directory: string, frontmatter: string, body = '# Body\n'): Promise<void> {
  const skillDir = join(root, 'skills', directory)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
}

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('AgentPluginSkillProvider', () => {
  it('lists portable skills in directory order and loads their bodies', async () => {
    const root = await pluginRoot()
    await writeSkill(root, 'beta-skill', 'name: beta-skill\ndescription: Beta instructions')
    await writeSkill(root, 'alpha-skill', 'name: alpha-skill\ndescription: Alpha instructions', '# Alpha\n\nBody text.\n')
    const provider = new AgentPluginSkillProvider([{ root }], 300)

    const candidates = await provider.list({})
    expect(candidates.map(candidate => candidate.name)).toEqual(['alpha-skill', 'beta-skill'])
    expect(candidates[0]).toMatchObject({
      description: 'Alpha instructions',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'agent-plugins',
      source: 'custom',
      rank: 300,
      path: join(await realpath(root), 'skills', 'alpha-skill', 'SKILL.md'),
      resourceBase: { kind: 'directory', path: join(await realpath(root), 'skills', 'alpha-skill') },
    })

    await expect(provider.get(candidates[0]!, {})).resolves.toMatchObject({
      name: 'alpha-skill',
      content: '# Alpha\n\nBody text.',
    })
  })

  it('returns no candidates without a skills directory', async () => {
    const provider = new AgentPluginSkillProvider([{ root: await pluginRoot() }], 300)
    await expect(provider.list({})).resolves.toEqual([])
  })

  it.each([
    ['missing frontmatter', '# No frontmatter'],
    ['invalid YAML', '---\nname: [\n---\nbody'],
    ['non-object frontmatter', '---\n- one\n---\nbody'],
    ['missing name', '---\ndescription: Only a description\n---\nbody'],
    ['name that differs from its directory', '---\nname: other-skill\ndescription: Mismatch\n---\nbody'],
    ['invalid name', '---\nname: Alpha_Skill\ndescription: Invalid\n---\nbody'],
  ])('skips a skill with %s', async (_label, raw) => {
    const root = await pluginRoot()
    const skillDir = join(root, 'skills', 'alpha-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), raw)
    const provider = new AgentPluginSkillProvider([{ root }], 300)
    await expect(provider.list({})).resolves.toEqual([])
  })

  it('skips an empty description and one over 1024 characters', async () => {
    const root = await pluginRoot()
    await writeSkill(root, 'empty-skill', 'name: empty-skill\ndescription: ""')
    await writeSkill(root, 'long-skill', `name: long-skill\ndescription: ${'d'.repeat(1025)}`)
    const provider = new AgentPluginSkillProvider([{ root }], 300)
    await expect(provider.list({})).resolves.toEqual([])
  })

  it('skips directories without SKILL.md and non-directory entries', async () => {
    const root = await pluginRoot()
    await mkdir(join(root, 'skills', 'empty-dir'), { recursive: true })
    await writeFile(join(root, 'skills', 'loose.md'), '---\nname: loose\ndescription: Loose\n---\n')
    const provider = new AgentPluginSkillProvider([{ root }], 300)
    await expect(provider.list({})).resolves.toEqual([])
  })

  it('skips a skill directory that a symlink moves outside the package', async () => {
    const root = await pluginRoot()
    const outside = await pluginRoot()
    await writeSkill(outside, 'linked-skill', 'name: linked-skill\ndescription: Linked')
    await mkdir(join(root, 'skills'), { recursive: true })
    await symlink(join(outside, 'skills', 'linked-skill'), join(root, 'skills', 'linked-skill'))
    const provider = new AgentPluginSkillProvider([{ root }], 300)
    await expect(provider.list({})).resolves.toEqual([])
  })

  it('returns undefined when the skill file vanished after listing', async () => {
    const root = await pluginRoot()
    await writeSkill(root, 'alpha-skill', 'name: alpha-skill\ndescription: Alpha')
    const provider = new AgentPluginSkillProvider([{ root }], 300)
    const [candidate] = await provider.list({})
    await rm(join(root, 'skills', 'alpha-skill', 'SKILL.md'))
    await expect(provider.get(candidate!, {})).resolves.toBeUndefined()
  })

  it('honours an aborted lookup signal', async () => {
    const root = await pluginRoot()
    await writeSkill(root, 'alpha-skill', 'name: alpha-skill\ndescription: Alpha')
    const provider = new AgentPluginSkillProvider([{ root }], 300)
    const controller = new AbortController()
    controller.abort()
    await expect(provider.list({ signal: controller.signal })).rejects.toThrow()
    const candidates = await provider.list({})
    await expect(provider.get(candidates[0]!, { signal: controller.signal })).rejects.toThrow()
  })
})
describe('AgentPluginSkillProvider edge cases', () => {
  it('returns nothing when skills is a file instead of a directory', async () => {
    const root = await pluginRoot()
    await writeFile(join(root, 'skills'), 'not a directory')
    const provider = new AgentPluginSkillProvider([{ root }], 300)
    await expect(provider.list({})).resolves.toEqual([])
  })

  it('skips a skill whose frontmatter block is only separators', async () => {
    const root = await pluginRoot()
    const skillDir = join(root, 'skills', 'alpha-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\n---\nbody')
    const provider = new AgentPluginSkillProvider([{ root }], 300)
    await expect(provider.list({})).resolves.toEqual([])
  })

  it('accepts a skill whose SKILL.md resolves inside the package', async () => {
    const root = await pluginRoot()
    await writeSkill(root, 'alpha-skill', 'name: alpha-skill\ndescription: Alpha')
    const provider = new AgentPluginSkillProvider([{ root }], 300)
    await expect(provider.list({})).resolves.toHaveLength(1)
  })
})

describe('AgentPluginSkillProvider containment', () => {
  it('skips every skill when the skills directory itself is a symlink out of the package', async () => {
    const root = await pluginRoot()
    const outside = await pluginRoot()
    await writeSkill(outside, 'alpha-skill', 'name: alpha-skill\ndescription: Alpha')
    await symlink(join(outside, 'skills'), join(root, 'skills'))
    const provider = new AgentPluginSkillProvider([{ root }], 300)
    await expect(provider.list({})).resolves.toEqual([])
  })

  it('skips a SKILL.md symlink that resolves outside the package', async () => {
    const root = await pluginRoot()
    const outside = await pluginRoot()
    await writeFile(join(outside, 'SKILL.md'), '---\nname: alpha-skill\ndescription: Alpha\n---\nbody')
    await mkdir(join(root, 'skills', 'alpha-skill'), { recursive: true })
    await symlink(join(outside, 'SKILL.md'), join(root, 'skills', 'alpha-skill', 'SKILL.md'))
    const provider = new AgentPluginSkillProvider([{ root }], 300)
    await expect(provider.list({})).resolves.toEqual([])
  })
})
