import { describe, expect, it } from 'vitest'
import { evaluateApprovalRules, matchApprovalPattern } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRule } from '@deepseek-ai/dsh-user-approval'

const rule = (action: string, resource: string, effect: ApprovalRule['effect']): ApprovalRule => ({ action, resource, effect })

describe('matchApprovalPattern', () => {
  it('matches literal text and wildcards across separators', () => {
    expect(matchApprovalPattern('write', 'write')).toBe(true)
    expect(matchApprovalPattern('write', 'reads')).toBe(false)
    expect(matchApprovalPattern('src/*', 'src/index.ts')).toBe(true)
    expect(matchApprovalPattern('src/*.ts', 'src/deep/nested/file.ts')).toBe(true)
    expect(matchApprovalPattern('src/*.ts', 'src/file.js')).toBe(false)
    expect(matchApprovalPattern('?at', 'cat')).toBe(true)
    expect(matchApprovalPattern('?at', 'coat')).toBe(false)
  })

  it('treats regex metacharacters in a pattern literally', () => {
    for (const pattern of ['a.b', 'a+b', '(x)', '[y]', '{z}', 'a|b', 'a\\b', 'a$']) {
      expect(matchApprovalPattern(pattern, pattern)).toBe(true)
      expect(matchApprovalPattern(pattern, `${pattern}x`)).toBe(false)
    }
  })
})

describe('evaluateApprovalRules', () => {
  it('returns undefined without rules and without a match', () => {
    expect(evaluateApprovalRules([], { action: 'write', resources: ['a.md'] })).toBeUndefined()
    expect(evaluateApprovalRules([rule('bash', '*', 'allow')], { action: 'write', resources: ['a.md'] })).toBeUndefined()
  })

  it('matches a rule against any one declared resource', () => {
    expect(evaluateApprovalRules([rule('write', 'docs/**', 'allow')], {
      action: 'write', resources: ['src/a.ts', 'notes/guide.txt'],
    })).toBe('allow')
  })

  it('matches a named resource rule only against a declared resource', () => {
    const rules = [rule('echo', 'notes.txt', 'allow')]
    expect(evaluateApprovalRules(rules, { action: 'echo', resources: [] })).toBeUndefined()
    expect(evaluateApprovalRules(rules, { action: 'echo', resources: ['notes.txt'] })).toBe('allow')
  })

  it('lets the last matching rule win so a narrow exception can follow a broad rule', () => {
    const rules = [
      rule('bash', '*', 'allow'),
      rule('bash', 'git *', 'deny'),
      rule('bash', 'git status', 'allow'),
    ]
    expect(evaluateApprovalRules(rules, { action: 'bash', resources: ['git push'] })).toBe('deny')
    expect(evaluateApprovalRules(rules, { action: 'bash', resources: ['git status'] })).toBe('allow')
    expect(evaluateApprovalRules(rules, { action: 'bash', resources: ['ls'] })).toBe('allow')
  })

  it('supports an explicit ask effect that overrides an earlier allow', () => {
    const rules = [rule('write', '**', 'allow'), rule('write', 'secrets/**', 'ask')]
    expect(evaluateApprovalRules(rules, { action: 'write', resources: ['secrets/key'] })).toBe('ask')
    expect(evaluateApprovalRules(rules, { action: 'write', resources: ['notes/guide.txt'] })).toBe('allow')
  })
})
