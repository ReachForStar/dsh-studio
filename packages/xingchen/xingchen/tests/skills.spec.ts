// Bundled star-domain skills: the provider lists `git`/`run`/`log` from the
// package's own assets, loads each body, and refuses a missing asset root.
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillProvider } from '@deepseek-ai/dsh-skill'
import * as xingchenSkills from '../src/skills.ts'

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.()
})

interface Harness {
  readonly providers: SkillProvider[]
}

/** Mount the provider with a capturing skill registry. */
async function harness(config: Record<string, unknown> = {}): Promise<Harness> {
  const ctx = new Context()
  const providers: SkillProvider[] = []
  ctx.provide('skills', {
    registerProvider(factory: () => SkillProvider) {
      const provider = factory()
      providers.push(provider)
      return () => {
        providers.splice(providers.indexOf(provider), 1)
      }
    },
  } as never)
  const plugin = await ctx.plugin(xingchenSkills, config)
  disposers.push(async () => { await plugin.dispose() })
  return { providers }
}

describe('@reachforstar/dsh-xingchen/skills', () => {
  it('Loader 可解包模块导出（无 default 导出）', () => {
    expect(xingchenSkills.name).toBe('xingchen-skills')
    expect(xingchenSkills.inject).toEqual(['skills'])
    expect('default' in xingchenSkills).toBe(false)
  })

  it('注册 git / run / log 三个可被用户与模型调用的内置技能', async () => {
    const { providers } = await harness()
    expect(providers).toHaveLength(1)
    const provider = providers[0]!
    expect(provider.name).toBe(xingchenSkills.PROVIDER_NAME)
    const listed = await provider.list({})
    if (!Array.isArray(listed)) throw new TypeError('bundled provider must return the array shorthand')
    const candidates = listed
    expect(candidates.map(candidate => candidate.name)).toEqual(['git', 'run', 'log'])
    for (const candidate of candidates) {
      expect(candidate.invocation).toEqual({ modelInvocable: true, userInvocable: true })
      expect(candidate.source).toBe('bundled')
      expect(candidate.provider).toBe(xingchenSkills.PROVIDER_NAME)
      expect(candidate.description).toContain('Use when')
    }
    const definition = await provider.get(candidates[0]!, {})
    expect(definition?.content).toContain('# Git history reading')
    expect(definition?.content).not.toContain('---\nname:')
  })

  it('缺少资源文件或传入相对 assetRoot 时拒绝装配', async () => {
    await expect(harness({ assetRoot: 'relative/path' }))
      .rejects.toThrow('assetRoot must be an absolute directory')
    await expect(harness({ assetRoot: 'C:/definitely-missing-xingchen-skills' }))
      .rejects.toThrow('SKILL.md')
  })
})
