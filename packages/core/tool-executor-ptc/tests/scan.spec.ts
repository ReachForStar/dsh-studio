import { describe, expect, it } from 'vitest'
import { scanToolReferences } from '@deepseek-ai/dsh-tool-executor-ptc/src/scan.ts'

describe('scanToolReferences', () => {
  it('collects static tool paths in first-seen order', () => {
    const scan = scanToolReferences(`
      await tools.bash({ command: 'ls' })
      const page = await tools["my-mcp"].read({ id: 1 })
      await tools.write({ file_path: 'a.txt' })
      inspect(page)
    `)
    expect(scan).toEqual({ tools: ['bash', 'my-mcp.read', 'write'] })
  })

  it('strips type annotations before parsing', () => {
    const scan = scanToolReferences('const n: number = 1\nawait tools.bash({ command: `echo ${n}` })')
    expect(scan.tools).toEqual(['bash'])
  })

  it('reports a tool named by several calls once', () => {
    expect(scanToolReferences('await tools.bash({})\nawait tools.bash({})').tools).toEqual(['bash'])
  })

  it('keeps only the longest static chain', () => {
    expect(scanToolReferences('await tools.server.list({})').tools).toEqual(['server.list'])
  })

  it('records a quoted path segment verbatim', () => {
    expect(scanToolReferences('await tools["my-mcp.tool"]({})').tools).toEqual(['my-mcp.tool'])
  })

  it('ignores member expressions of other objects', () => {
    expect(scanToolReferences('const value = { bash: 1 }\nawait value.bash\nawait value[name]')).toEqual({ tools: [] })
    expect(scanToolReferences('lookup[key].bash')).toEqual({ tools: [] })
  })

  it('refuses dynamic access, aliasing, and shadowing', () => {
    for (const code of [
      'const name = "bash"\nawait tools[name]({})',
      'const t = tools\nawait t.bash({})',
      'await Promise.all([tools].map(call => call))',
      'function run(tools: unknown) { return tools }',
      'const tools = {}\nawait tools.bash({})',
    ]) {
      const scan = scanToolReferences(code)
      expect(scan.tools, code).toEqual([])
      expect(scan.problem, code).toBeDefined()
    }
  })

  it('treats unstrippable and unparseable programs as no resources', () => {
    const unstrippable = scanToolReferences('await tools.bash({')
    expect(unstrippable.tools).toEqual([])
    expect(unstrippable.problem).toContain('does not strip')
    // Strict-module parsing rejects `with`, which type stripping passes through.
    const unparseable = scanToolReferences('delete missing\nawait tools.bash({})')
    expect(unparseable.tools).toEqual([])
    expect(unparseable.problem).toContain('does not parse')
  })

  it('refuses class, catch, and import bindings named tools', () => {
    for (const code of [
      'class tools {}',
      'try {} catch (tools) {}',
      "import { b as tools } from 'pkg'",
    ]) {
      expect(scanToolReferences(code).problem, code).toBeDefined()
    }
  })

  it('handles an empty program', () => {
    expect(scanToolReferences('   ')).toEqual({ tools: [] })
  })
})
