import { describe, expect, it } from 'vitest'
import {
  BOUNDARY_TOOLS,
  gatePlan,
  gateToolCall,
  overlayPath,
  resolvePolicy,
  rewriteArguments,
  type Config,
} from '../src/index.ts'

const config: Config = {
  workspaceRoot: '/work/repo',
  overlayRoot: '/tmp/overlay',
  allowWrites: true,
}

const strict: Config = {
  workspaceRoot: '/work/repo',
  overlayRoot: '/tmp/overlay',
  allowWrites: false,
}

describe('resolvePolicy', () => {
  it('applies defaults for missing and empty overrides', () => {
    expect(resolvePolicy(config).readOnlyTools).toEqual(['read', 'grep', 'glob', 'ls', 'lsp'])
    const emptyTools: Config = { workspaceRoot: '/work/repo', overlayRoot: '/tmp/overlay', allowWrites: true, readOnlyTools: [] }
    expect(resolvePolicy(emptyTools).readOnlyTools).toContain('read')
    const customWrites: Config = { workspaceRoot: '/work/repo', overlayRoot: '/tmp/overlay', allowWrites: true, writeTools: ['apply_patch'] }
    expect(resolvePolicy(customWrites).writeTools).toEqual(['apply_patch'])
  })
})

describe('overlayPath', () => {
  it('maps workspace paths and keeps the suffix', () => {
    expect(overlayPath('/work/repo', '/tmp/overlay', 'src/a.ts')).toBe('/tmp/overlay/src/a.ts')
    expect(overlayPath('/work/repo', '/tmp/overlay', '/work/repo/src/a.ts')).toBe('/tmp/overlay/src/a.ts')
    expect(overlayPath('/work/repo', '/tmp/overlay', '/work/repo')).toBe('/tmp/overlay')
  })

  it('rejects paths outside the workspace', () => {
    expect(overlayPath('/work/repo', '/tmp/overlay', '../escape.ts')).toBeUndefined()
    expect(overlayPath('/work/repo', '/tmp/overlay', '/etc/passwd')).toBeUndefined()
  })
})

describe('gateToolCall', () => {
  it('allows read-only tools unchanged', () => {
    expect(gateToolCall('read', { file_path: 'src/a.ts' }, config)).toEqual({ action: 'allow', tool: 'read' })
    expect(gateToolCall('grep', {}, config).action).toBe('allow')
  })

  it('redirects writes into the overlay when writes are allowed', () => {
    const decision = gateToolCall('write', { file_path: 'src/b.ts' }, config)
    expect(decision).toMatchObject({
      action: 'redirect',
      tool: 'write',
      redirectKey: 'file_path',
      redirectPath: '/tmp/overlay/src/b.ts',
    })
  })

  it('stops writes when writes are not allowed', () => {
    expect(gateToolCall('edit', { file_path: 'src/a.ts' }, strict)).toEqual({
      action: 'boundary',
      tool: 'edit',
      reason: 'write_not_allowed:edit',
    })
  })

  it('stops writes whose path escapes the workspace or is missing', () => {
    const escaped = gateToolCall('write', { file_path: '/etc/passwd' }, config)
    expect(escaped.action === 'boundary' && escaped.reason).toBe('path_outside_workspace:write')
    const missing = gateToolCall('write', {}, config)
    expect(missing.action === 'boundary' && missing.reason).toBe('path_outside_workspace:write')
  })

  it('honours custom tool lists and skips non-string paths', () => {
    const custom: Config = {
      workspaceRoot: '/work/repo',
      overlayRoot: '/tmp/overlay',
      allowWrites: true,
      readOnlyTools: ['inspect'],
      writeTools: ['apply_patch'],
      pathArgumentKeys: ['target'],
    }
    expect(gateToolCall('inspect', {}, custom).action).toBe('allow')
    expect(gateToolCall('write', { file_path: 'x' }, custom).action).toBe('boundary')
    const patched = gateToolCall('apply_patch', { target: 'a.ts', other: 1 }, custom)
    expect(patched.action === 'redirect' && patched.redirectPath)
      .toBe('/tmp/overlay/a.ts')
    expect(gateToolCall('apply_patch', { target: '   ' }, custom).action).toBe('boundary')
  })

  it('stops every other tool', () => {
    for (const tool of BOUNDARY_TOOLS) {
      expect(gateToolCall(tool, {}, config)).toMatchObject({ action: 'boundary', reason: `unsupported_tool:${tool}` })
    }
    expect(gateToolCall('custom_mcp_tool', {}, config).action).toBe('boundary')
  })
})

describe('rewriteArguments', () => {
  it('rewrites the redirect key without mutating the input', () => {
    const args = { file_path: 'src/a.ts', content: 'x' }
    const decision = gateToolCall('write', args, config)
    const rewritten = rewriteArguments(args, decision)
    expect(rewritten).toEqual({ file_path: '/tmp/overlay/src/a.ts', content: 'x' })
    expect(args.file_path).toBe('src/a.ts')
  })

  it('copies arguments for allowed and boundary decisions', () => {
    const args = { file_path: 'src/a.ts' }
    expect(rewriteArguments(args, gateToolCall('read', args, config))).toEqual(args)
    expect(rewriteArguments(args, gateToolCall('write', args, strict))).toEqual(args)
  })
})

describe('gatePlan', () => {
  it('returns every allowed step in order', () => {
    const plan = gatePlan([
      { tool: 'read', args: { file_path: 'a.ts' } },
      { tool: 'write', args: { file_path: 'b.ts' } },
    ], config)
    expect(plan.allowed.map(entry => entry.decision.action)).toEqual(['allow', 'redirect'])
    expect(plan.stopped).toBeUndefined()
  })

  it('stops at the first boundary and keeps earlier steps', () => {
    const plan = gatePlan([
      { tool: 'read', args: {} },
      { tool: 'web_fetch', args: {} },
      { tool: 'read', args: {} },
    ], config)
    expect(plan.allowed).toHaveLength(1)
    expect(plan.stopped).toMatchObject({ action: 'boundary', tool: 'web_fetch' })
  })
})
