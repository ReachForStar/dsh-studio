/** Excalidraw scene model tools: registration, schema enforcement, and the
 * workspace-scene read/write behavior. The tools are captured through a mock
 * tool registry, then executed directly with a fake agent session. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply, sanitizeScene, SCENE_RELATIVE, sceneToSvg } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

/** Minimal context double with an inject that forwards to a mock registry. */
function bench() {
  type ToolDefinition = {
    name: string
    execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
    parameters: unknown
    output: {
      render?: (args: Record<string, unknown>, value: Record<string, unknown>) => unknown
      presentationMeta?: (args: Record<string, unknown>, value: Record<string, unknown>) => unknown
    }
    presentCall?: (args: Record<string, unknown>) => Record<string, unknown>
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
    b.disposers.forEach((dispose) => { dispose() })
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

      const onDisk = JSON.parse(await readFile(join(workspace, SCENE_RELATIVE), 'utf8')) as { elements: Record<string, unknown>[] }
      // sanitizeScene fills render-critical defaults on write, so only the
      // user-supplied identity fields are asserted here, plus the repaired
      // element where a shape was missing seed/version.
      expect(onDisk.elements).toHaveLength(2)
      for (const el of onDisk.elements) {
        expect(el['id']).toBeDefined()
        expect(el['type']).toBeDefined()
        expect(typeof el['seed']).toBe('number')
        expect(el['version']).toBe(1)
        expect(el['angle']).toBe(0)
        expect(el['isDeleted']).toBe(false)
      }

      const readTool = b.registered.find(entry => entry.name === 'excalidraw_read')!
      const value = await readTool.definition.execute({}, execFor(workspace))
      expect(value).toMatchObject({ exists: true })
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

      const onDisk = JSON.parse(await readFile(join(workspace, SCENE_RELATIVE), 'utf8')) as { elements: Record<string, unknown>[] }
      expect(onDisk.elements).toHaveLength(3)
      expect(onDisk.elements.map(e => e.type)).toEqual(['rectangle', 'text', 'arrow'])
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
      const onDisk = JSON.parse(await readFile(join(workspace, SCENE_RELATIVE), 'utf8')) as { elements: Record<string, unknown>[] }
      expect(onDisk.elements).toHaveLength(1)
      expect(onDisk.elements[0]!.type).toBe('ellipse')
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

describe('excalidraw tool presentation and edge inputs', () => {
  it('builds call cards, render rows, and presentation metadata', () => {
    const b = bench()
    const tool = (name: string) => b.registered.find(entry => entry.name === name)!.definition
    expect(tool('excalidraw_read').presentCall?.({})).toMatchObject({ title: 'Read Excalidraw scene' })
    expect(tool('excalidraw_read').output.render?.({}, { summary: { elementCount: 3 }, sceneJson: '{}' }))
      .toEqual([{ type: 'text', text: 'Excalidraw scene: 3 elements (full JSON included).' }])
    expect(tool('excalidraw_read').output.render?.({}, { summary: {} }))
      .toEqual([{ type: 'text', text: 'Excalidraw scene: 0 elements.' }])
    expect(tool('excalidraw_write').presentCall?.({ scene: 'abcd' })).toMatchObject({ rawInput: 'elements: 4 chars' })
    expect(tool('excalidraw_write').output.render?.({}, { elementCount: 2 }))
      .toEqual([{ type: 'text', text: 'Excalidraw scene saved: 2 elements.' }])
    expect(tool('excalidraw_write').output.presentationMeta?.({}, { previewSvg: '<svg/>' })).toEqual({ previewSvg: '<svg/>' })
    expect(tool('excalidraw_write').output.presentationMeta?.({}, {})).toEqual({ previewSvg: null })
    const shapes = Array.from({ length: 3 }, () => ({ type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }))
    expect(tool('excalidraw_draw').presentCall?.({ elements: shapes })).toMatchObject({ rawInput: '3 shapes' })
    expect(tool('excalidraw_draw').presentCall?.({ elements: [] })).toMatchObject({ rawInput: '0 shapes' })
    expect(tool('excalidraw_draw').output.render?.({}, { added: 2, totalElements: 5 }))
      .toEqual([{ type: 'text', text: 'Drew 2 shapes on the canvas (5 total).' }])
    expect(tool('excalidraw_draw').output.presentationMeta?.({}, { previewSvg: '<svg/>' })).toEqual({ previewSvg: '<svg/>' })
    expect(tool('excalidraw_export').presentCall?.({ path: 'docs/a.svg' })).toMatchObject({ rawInput: 'path: docs/a.svg' })
    expect(tool('excalidraw_export').presentCall?.({})).toMatchObject({ rawInput: 'path: .dsh/excalidraw/export.svg' })
    expect(tool('excalidraw_export').output.render?.({}, { elementCount: 4, path: '/w/a.svg' }))
      .toEqual([{ type: 'text', text: 'Exported 4 elements to /w/a.svg.' }])
  })

  it('resolves the scene through the workspace registry when a workspace owns the session', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const registry = { list: () => [{ path: workspace, sessionIds: ['session-1'] }] }
      const b = bench()
      const ctx = { ...b.ctx, get: (name: string) => (name === 'workspaceRegistry' ? registry : undefined) }
      b.disposers.forEach((dispose) => { dispose() })
      ;(b.ctx as { get: unknown }).get = ctx.get
      apply(b.ctx as unknown as Context)
      const writeTool = b.registered.find(entry => entry.name === 'excalidraw_write')!
      const written = await writeTool.definition.execute(
        { scene: JSON.stringify({ elements: [{ id: 'a', type: 'rectangle' }], appState: {} }) },
        execFor('/not-the-workspace'),
      )
      expect(written).toMatchObject({ ok: true, cwd: workspace })
      expect(await readFile(join(workspace, SCENE_RELATIVE), 'utf8')).toContain('rectangle')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('carries shape styles and gives a line its default points', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const drawTool = b.registered.find(entry => entry.name === 'excalidraw_draw')!
      const drawn = await drawTool.definition.execute({
        elements: [
          { type: 'line', x: 0, y: 0, width: 30, height: 40, strokeColor: '#f00', backgroundColor: '#0f0', fillStyle: 'solid', strokeWidth: 4, opacity: 250 },
        ],
      }, execFor(workspace))
      expect(drawn).toMatchObject({ added: 1, skipped: 0 })
      const scene = JSON.parse(await readFile(join(workspace, SCENE_RELATIVE), 'utf8')) as { elements: Record<string, unknown>[] }
      // A line without points gets the diagonal across its box.
      expect(scene.elements[0]).toMatchObject({ type: 'line', points: [[0, 0], [30, 40]], startArrowhead: null, endArrowhead: null, opacity: 100, fillStyle: 'solid' })
      expect(scene.elements[0]?.['elbowed']).toBeUndefined()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('caps one draw call and keeps the existing appState', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const drawTool = b.registered.find(entry => entry.name === 'excalidraw_draw')!
      await expect(drawTool.definition.execute({
        elements: Array.from({ length: 257 }, () => ({ type: 'rectangle', x: 0, y: 0, width: 1, height: 1 })),
      }, execFor(workspace))).rejects.toThrow('at most 256')
      await mkdir(join(workspace, '.dsh', 'excalidraw'), { recursive: true })
      await writeFile(join(workspace, SCENE_RELATIVE), JSON.stringify({ elements: [{ id: 'old', type: 'rectangle' }], appState: { theme: 'dark' } }), 'utf8')
      const drawn = await drawTool.definition.execute({ elements: [{ type: 'ellipse', x: 0, y: 0, width: 5, height: 5 }] }, execFor(workspace))
      expect(drawn).toMatchObject({ added: 1, totalElements: 2 })
      const scene = JSON.parse(await readFile(join(workspace, SCENE_RELATIVE), 'utf8')) as { appState: Record<string, unknown> }
      expect(scene.appState).toEqual({ theme: 'dark' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('drops a file-less image on write and caps the scene size', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const writeTool = b.registered.find(entry => entry.name === 'excalidraw_write')!
      const written = await writeTool.definition.execute({
        scene: JSON.stringify({
          elements: [{ id: 'img', type: 'image', status: 'pending' }, { id: 'ok', type: 'rectangle' }],
          appState: {},
        }),
      }, execFor(workspace))
      expect(written).toMatchObject({ ok: true, elementCount: 1 })
      const oversized = JSON.stringify({ elements: [{ id: 'big', type: 'rectangle', text: 'x'.repeat(1024 * 1024) }], appState: {} })
      await expect(writeTool.definition.execute({ scene: oversized }, execFor(workspace))).rejects.toThrow('size cap')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('export rejects a missing or corrupted scene and honors a transparent canvas', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const exportTool = b.registered.find(entry => entry.name === 'excalidraw_export')!
      await expect(exportTool.definition.execute({}, execFor(workspace))).rejects.toThrow('no scene to export')
      await mkdir(join(workspace, '.dsh', 'excalidraw'), { recursive: true })
      await writeFile(join(workspace, SCENE_RELATIVE), '{broken', 'utf8')
      await expect(exportTool.definition.execute({}, execFor(workspace))).rejects.toThrow('corrupted')
      await writeFile(join(workspace, SCENE_RELATIVE), JSON.stringify({
        elements: [{ id: 'r', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
        appState: { viewBackgroundColor: '#abcdef' },
      }), 'utf8')
      const opaque = await exportTool.definition.execute({ path: 'opaque.svg' }, execFor(workspace))
      expect(await readFile((opaque as { path: string }).path, 'utf8')).toContain('#abcdef')
      const transparent = await exportTool.definition.execute({ path: 'clear.svg', transparent: true }, execFor(workspace))
      expect(await readFile((transparent as { path: string }).path, 'utf8')).not.toContain('#abcdef')
      // A scene JSON that is not an object exports an empty canvas.
      await writeFile(join(workspace, SCENE_RELATIVE), JSON.stringify([1, 2]), 'utf8')
      expect(await exportTool.definition.execute({ path: 'empty.svg' }, execFor(workspace))).toMatchObject({ elementCount: 0 })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('sanitizeScene and sceneToSvg', () => {
  it('leaves scenes without an elements array untouched', () => {
    expect(sanitizeScene(null)).toBeNull()
    expect(sanitizeScene({ appState: {} })).toEqual({ appState: {} })
    const nonArray = { elements: 'nope' }
    expect(sanitizeScene(nonArray)).toBe(nonArray)
  })

  it('normalizes malformed elements and keeps non-object entries', () => {
    const scene = { elements: ['junk', { id: 7, type: 'rectangle', version: null }, { id: 'img', type: 'image', fileId: '' }] }
    const repaired = sanitizeScene(scene) as { elements: unknown[] }
    expect(repaired.elements).toHaveLength(2)
    expect(repaired.elements[0]).toBe('junk')
    const filled = repaired.elements[1] as { seed: number } & Record<string, unknown>
    expect(filled).toMatchObject({
      version: 1, angle: 0, isDeleted: false, groupIds: [], frameId: null,
      boundElements: null, link: null, locked: false, roundness: null,
    })
    // The same id always seeds the same value, so re-reading is idempotent.
    const seed = filled.seed
    sanitizeScene(scene)
    expect(filled.seed).toBe(seed)
  })

  it('renders every supported shape plus a backdrop and rotation', () => {
    const elements = [
      { id: 'd', type: 'diamond', x: 0, y: 0, width: 40, height: 20, strokeColor: '#123456' },
      { id: 'f', type: 'freedraw', x: 0, y: 0, points: [[0, 0], [4, 4], 'junk'] },
      { id: 'm', type: 'mystery', x: 0, y: 0, width: 1, height: 1 },
      { id: 'one', type: 'line', x: 0, y: 0, points: [[0, 0]] },
      { id: 'r', type: 'rectangle', x: 10, y: 10, width: 10, height: 10, angle: Math.PI / 2, opacity: 0 },
      { id: 'gone', type: 'rectangle', isDeleted: true },
    ]
    const svg = sceneToSvg(elements, '#ffffff')
    expect(svg).toContain('<rect x="')
    expect(svg).toContain('<polygon points="20,0 40,10 20,20 0,10"')
    expect(svg).toContain('<path d="M0,0 L4,4"')
    expect(svg).toContain('transform="rotate(90 ')
    expect(svg).toContain('opacity="0.05"')
    expect(svg).not.toContain('gone')
    // Only a one-point line renders nothing extra.
    expect(svg.split('<polyline').length - 1).toBe(0)
  })

  it('falls back to a default viewBox for an empty scene', () => {
    const svg = sceneToSvg([], null)
    expect(svg).toContain('viewBox="-24 -24 848 648"')
    expect(svg).not.toContain('<rect x=')
  })

  it('summarizes a scalar scene and a scene with junk elements', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const readTool = b.registered.find(entry => entry.name === 'excalidraw_read')!
      await mkdir(join(workspace, '.dsh', 'excalidraw'), { recursive: true })
      await writeFile(join(workspace, SCENE_RELATIVE), '"just-a-string"', 'utf8')
      expect(await readTool.definition.execute({}, execFor(workspace))).toMatchObject({
        exists: true,
        summary: { elementCount: 0, byType: {}, textElements: [], theme: 'light', viewBackgroundColor: 'transparent' },
        elements: [],
      })
      await writeFile(join(workspace, SCENE_RELATIVE), JSON.stringify({
        elements: [7, { id: 'x', type: 5 }, { id: 't', type: 'text', text: 'hi', x: 1 }],
        appState: { viewBackgroundColor: 5 },
      }), 'utf8')
      const value = await readTool.definition.execute({}, execFor(workspace)) as {
        summary: { byType: Record<string, number>; viewBackgroundColor: string }
        elements: Record<string, unknown>[]
      }
      expect(value.summary.byType).toEqual({ unknown: 1, text: 1 })
      expect(value.summary.viewBackgroundColor).toBe('transparent')
      expect(value.elements).toEqual([{}, { id: 'x', type: 5 }, { id: 't', type: 'text', x: 1, text: 'hi' }])
      await writeFile(join(workspace, SCENE_RELATIVE), JSON.stringify({
        elements: [{ id: 'r', type: 'rectangle' }],
        appState: { viewBackgroundColor: '#123456', theme: 'dark' },
      }), 'utf8')
      expect((await readTool.definition.execute({}, execFor(workspace)) as { summary: Record<string, unknown> }).summary)
        .toMatchObject({ viewBackgroundColor: '#123456', theme: 'dark' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('reads, draws, and exports only inside an owning session', async () => {
    const b = bench()
    const detached = { agent: undefined, signal: new AbortController().signal }
    const tool = (name: string) => b.registered.find(entry => entry.name === name)!.definition
    await expect(tool('excalidraw_read').execute({}, detached)).rejects.toThrow('requires an owning agent session')
    await expect(tool('excalidraw_draw').execute({ elements: [{ type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }] }, detached))
      .rejects.toThrow('requires an owning agent session')
    await expect(tool('excalidraw_export').execute({}, detached)).rejects.toThrow('requires an owning agent session')
  })

  it('draws a text shape without content and tolerates a damaged existing scene', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      await mkdir(join(workspace, '.dsh', 'excalidraw'), { recursive: true })
      await writeFile(join(workspace, SCENE_RELATIVE), JSON.stringify({ elements: 5, appState: 7 }), 'utf8')
      const drawTool = b.registered.find(entry => entry.name === 'excalidraw_draw')!
      const drawn = await drawTool.definition.execute({
        elements: [{ type: 'text', x: 0, y: 0, width: 10, height: 10 }],
      }, execFor(workspace))
      expect(drawn).toMatchObject({ added: 1, totalElements: 1 })
      const scene = JSON.parse(await readFile(join(workspace, SCENE_RELATIVE), 'utf8')) as { elements: Record<string, unknown>[]; appState: Record<string, unknown> }
      expect(scene.elements[0]).toMatchObject({ type: 'text', text: '', originalText: '' })
      expect(scene.appState).toEqual({})
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('writes an empty scene and keeps a canvas background', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const writeTool = b.registered.find(entry => entry.name === 'excalidraw_write')!
      const empty = await writeTool.definition.execute({ scene: JSON.stringify({ elements: [], appState: {} }) }, execFor(workspace))
      expect(empty).toMatchObject({ ok: true, elementCount: 0 })
      expect(empty).not.toHaveProperty('previewSvg')
      for (const color of ['transparent', '#eeeeee']) {
        const written = await writeTool.definition.execute({
          scene: JSON.stringify({ elements: [{ id: 'r', type: 'rectangle' }], appState: { viewBackgroundColor: color } }),
        }, execFor(workspace))
        expect((written as { previewSvg?: string }).previewSvg).toContain('<svg')
        expect((written as { previewSvg: string }).previewSvg.includes('fill="#eeeeee"')).toBe(color === '#eeeeee')
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('omits an oversized draw preview but keeps the rendering metadata fallback', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      const drawTool = b.registered.find(entry => entry.name === 'excalidraw_draw')!
      const shapes = Array.from({ length: 200 }, (_, index) => ({ type: 'text' as const, x: index, y: index, width: 10, height: 10, text: 'x'.repeat(400) }))
      const drawn = await drawTool.definition.execute({ elements: shapes }, execFor(workspace))
      expect(drawn).toMatchObject({ added: 200 })
      expect(drawn).not.toHaveProperty('previewSvg')
      expect(drawTool.definition.output.presentationMeta?.({}, drawn as Record<string, unknown>)).toEqual({ previewSvg: null })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('exports a scalar scene as an empty canvas', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-tool-'))
    try {
      const b = bench()
      await mkdir(join(workspace, '.dsh', 'excalidraw'), { recursive: true })
      await writeFile(join(workspace, SCENE_RELATIVE), '"scalar"', 'utf8')
      const exportTool = b.registered.find(entry => entry.name === 'excalidraw_export')!
      const exported = await exportTool.definition.execute({}, execFor(workspace))
      expect(exported).toMatchObject({ elementCount: 0 })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('renders degenerate point lists without inventing geometry', () => {
    const svg = sceneToSvg([
      1, null,
      { type: 'line', x: 0, y: 0, points: [[0, 0], ['x', 1]] },
      { type: 'arrow', x: 0, y: 0, points: [[0, 0], [0, 0]] },
      { type: 'line', x: 0, y: 0 },
      { type: 'freedraw', x: 0, y: 0, points: ['junk'] },
      { type: 'freedraw', x: 0, y: 0 },
    ], null)
    expect(svg).toContain('<polyline points="0,0 0,0"')
    // The zero-length arrow keeps a unit direction instead of dividing by zero.
    expect(svg).toContain('stroke-width=')
  })
})
