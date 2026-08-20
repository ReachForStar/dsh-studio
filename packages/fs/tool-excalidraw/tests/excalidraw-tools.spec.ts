/** Excalidraw scene model tools: registration, schema enforcement, and the
 * workspace-scene read/write behavior. The tools are captured through a mock
 * tool registry, then executed directly with a fake agent session. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply, SCENE_RELATIVE } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

/** Minimal context double with an inject that forwards to a mock registry. */
function bench() {
  type ToolDefinition = {
    name: string
    execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
    parameters: unknown
    output: unknown
  }
  const registered: { name: string; definition: ToolDefinition }[] = []
  const disposers: (() => void)[] = []
  const tools = {
    register(definition: ToolDefinition) {
      registered.push({ name: definition.name, definition })
      return () => {
        const index = registered.findIndex(entry => entry.name === definition.name)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
  const ctx = {
    tools,
    effect(fn: () => (() => void) | undefined) {
      const disposer = fn()
      if (disposer !== undefined) disposers.push(disposer)
    },
    get() { return undefined },
  }
  apply(ctx as unknown as Context)
  return { registered, disposers, ctx }
}

/** A fake agent execution carrying a workspace-owned session header. */
function execFor(cwd: string) {
  return {
    agent: { session: { id: 'session-1', header: { cwd } } },
    signal: new AbortController().signal,
  }
}

describe('excalidraw model tools', () => {
  it('registers all four tools and unwinds on dispose', () => {
    const b = bench()
    expect(b.registered.map(entry => entry.name).sort()).toEqual(['excalidraw_draw', 'excalidraw_export', 'excalidraw_read', 'excalidraw_write'])
    b.disposers.forEach(dispose => dispose())
    expect(b.registered).toHaveLength(0)
  })

  it('read returns an empty scene summary when no scene exists', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const tool = b.registered.find(entry => entry.name === 'excalidraw_read')!
      const value = await tool.definition.execute({}, execFor(workspace))
      expect(value).toMatchObject({ cwd: workspace, exists: false })
      expect((value as { summary: { elementCount: number } }).summary.elementCount).toBe(0)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('write persists the scene and read round-trips it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const writeTool = b.registered.find(entry => entry.name === 'excalidraw_write')!
      const scene = { elements: [{ id: 'a', type: 'rectangle' }, { id: 't', type: 'text', text: 'hello' }], appState: { theme: 'dark' } }
      const written = await writeTool.definition.execute({ scene: JSON.stringify(scene) }, execFor(workspace))
      expect(written).toMatchObject({ ok: true, elementCount: 2 })

      const onDisk = JSON.parse(await readFile(join(workspace, SCENE_RELATIVE), 'utf8'))
      expect(onDisk).toEqual(scene)

      const readTool = b.registered.find(entry => entry.name === 'excalidraw_read')!
      const value = await readTool.definition.execute({}, execFor(workspace))
      expect(value).toMatchObject({ exists: true, sceneJson: JSON.stringify(scene) })
      expect((value as { summary: { elementCount: number; byType: Record<string, number> } }).summary).toMatchObject({
        elementCount: 2,
        byType: { rectangle: 1, text: 1 },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects writes without an owning workspace', async () => {
    const b = bench()
    const writeTool = b.registered.find(entry => entry.name === 'excalidraw_write')!
    await expect(writeTool.definition.execute(
      { scene: JSON.stringify({ elements: [], appState: {} }) },
      { agent: undefined, signal: new AbortController().signal },
    )).rejects.toThrow('requires an owning agent session')
  })

  it('rejects invalid scene payloads', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const writeTool = b.registered.find(entry => entry.name === 'excalidraw_write')!
      await expect(writeTool.definition.execute({ scene: '' }, execFor(workspace))).rejects.toThrow('non-empty')
      await expect(writeTool.definition.execute({ scene: '{oops' }, execFor(workspace))).rejects.toThrow('not valid JSON')
      await expect(writeTool.definition.execute({ scene: '[1,2]' }, execFor(workspace))).rejects.toThrow('must be a JSON object')
      await expect(writeTool.definition.execute(
        { scene: JSON.stringify({ elements: [], appState: null }) },
        execFor(workspace),
      )).rejects.toThrow('elements')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('read reports a corrupted scene file as an error field', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const scenePath = join(workspace, SCENE_RELATIVE)
      await mkdir(join(scenePath, '..'), { recursive: true })
      await writeFile(scenePath, '{broken', 'utf8')
      const b = bench()
      const readTool = b.registered.find(entry => entry.name === 'excalidraw_read')!
      const value = await readTool.definition.execute({}, execFor(workspace))
      expect(value).toMatchObject({ exists: true })
      expect((value as { error?: string }).error).toContain('corrupted')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('draw appends shapes to a fresh scene and read reflects them', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const drawTool = b.registered.find(entry => entry.name === 'excalidraw_draw')!
      const drawn = await drawTool.definition.execute({
        elements: [
          { type: 'rectangle', x: 10, y: 20, width: 100, height: 50 },
          { type: 'text', x: 10, y: 80, width: 200, height: 30, text: 'answer' },
          { type: 'arrow', x: 0, y: 0, width: 50, height: 50, points: [[0, 0], [50, 50]] },
        ],
        action: 'append',
      }, execFor(workspace))
      expect(drawn).toMatchObject({ ok: true, added: 3, totalElements: 3, skipped: 0 })

      const onDisk = JSON.parse(await readFile(join(workspace, SCENE_RELATIVE), 'utf8'))
      expect(onDisk.elements).toHaveLength(3)
      expect(onDisk.elements.map((e: { type: string }) => e.type)).toEqual(['rectangle', 'text', 'arrow'])
      // Complete rendering fields: seed (roughjs needs it to draw the shape),
      // index (reconciliation), opacity 0-100 (1 would be near-invisible) and
      // roundness are all emitted by the tool.
      expect(onDisk.elements[0]).toHaveProperty('seed')
      expect(onDisk.elements[0]).toHaveProperty('version')
      expect(onDisk.elements[0]).toHaveProperty('roughness')
      expect(onDisk.elements[0]).toHaveProperty('index')
      expect(onDisk.elements[0]).toMatchObject({ opacity: 100, roundness: { type: 3 } })

      const readTool = b.registered.find(entry => entry.name === 'excalidraw_read')!
      const value = await readTool.definition.execute({}, execFor(workspace))
      expect((value as { elements: unknown[] }).elements).toHaveLength(3)
      expect((value as { elements: { type: string }[] }).elements[1]).toMatchObject({ type: 'text', text: 'answer' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('draw replace clears the canvas before adding', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const drawTool = b.registered.find(entry => entry.name === 'excalidraw_draw')!
      await drawTool.definition.execute({ elements: [{ type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] }, execFor(workspace))
      await drawTool.definition.execute({
        elements: [{ type: 'ellipse', x: 5, y: 5, width: 20, height: 20 }],
        action: 'replace',
      }, execFor(workspace))
      const onDisk = JSON.parse(await readFile(join(workspace, SCENE_RELATIVE), 'utf8'))
      expect(onDisk.elements).toHaveLength(1)
      expect(onDisk.elements[0].type).toBe('ellipse')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('draw skips unsupported types and rejects an all-invalid call', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const drawTool = b.registered.find(entry => entry.name === 'excalidraw_draw')!
      const drawn = await drawTool.definition.execute({
        elements: [
          { type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
          { type: 'wiggly-widget', x: 0, y: 0, width: 10, height: 10 },
        ],
      }, execFor(workspace))
      expect(drawn).toMatchObject({ added: 1, totalElements: 1, skipped: 1 })

      await expect(drawTool.definition.execute({
        elements: [{ type: 'nope', x: 0, y: 0, width: 1, height: 1 }],
      }, execFor(workspace))).rejects.toThrow('no supported element types')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('draw rejects non-array elements and a bad action', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const drawTool = b.registered.find(entry => entry.name === 'excalidraw_draw')!
      // A non-array `elements` is rejected by the tool schema before execute.
      await expect(drawTool.definition.execute({ elements: 'nope' }, execFor(workspace))).rejects.toThrow('must be an array')
      await expect(drawTool.definition.execute({ elements: [] }, execFor(workspace))).rejects.toThrow('non-empty array')
      await expect(drawTool.definition.execute({
        elements: [{ type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }],
        action: 'clear',
      }, execFor(workspace))).rejects.toThrow('append')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('export writes an SVG of the scene to the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const drawTool = b.registered.find(entry => entry.name === 'excalidraw_draw')!
      await drawTool.definition.execute({
        elements: [
          { type: 'rectangle', x: 10, y: 20, width: 100, height: 50 },
          { type: 'text', x: 10, y: 80, width: 200, height: 30, text: 'hello' },
          { type: 'arrow', x: 0, y: 0, width: 50, height: 50, points: [[0, 0], [50, 50]] },
        ],
      }, execFor(workspace))
      const exportTool = b.registered.find(entry => entry.name === 'excalidraw_export')!
      const result = await exportTool.definition.execute({}, execFor(workspace))
      expect(result).toMatchObject({ ok: true, elementCount: 3 })
      const abs = (result as { path: string }).path
      expect(abs.startsWith(workspace)).toBe(true)
      const svg = await readFile(abs, 'utf8')
      expect(svg).toContain('<svg')
      expect(svg).toContain('<rect')
      expect(svg).toContain('<text')
      expect(svg).toContain('hello')
      expect(svg).toContain('<polyline')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('export honors a custom path and rejects escaping paths', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const drawTool = b.registered.find(entry => entry.name === 'excalidraw_draw')!
      await drawTool.definition.execute({ elements: [{ type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] }, execFor(workspace))
      const exportTool = b.registered.find(entry => entry.name === 'excalidraw_export')!
      const result = await exportTool.definition.execute({ path: 'docs/diagram.svg' }, execFor(workspace))
      expect((result as { path: string }).path).toMatch(/[\\/]docs[\\/]diagram\.svg$/)
      expect(await readFile((result as { path: string }).path, 'utf8')).toContain('<svg')
      await expect(exportTool.definition.execute({ path: '../evil.svg' }, execFor(workspace))).rejects.toThrow('inside the workspace')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('export fails when no scene exists', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const exportTool = b.registered.find(entry => entry.name === 'excalidraw_export')!
      await expect(exportTool.definition.execute({}, execFor(workspace))).rejects.toThrow('no scene to export')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
