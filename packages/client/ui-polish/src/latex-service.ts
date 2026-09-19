/**
 * LaTeX panel host service (the Overleaf-style workflow over the local TeX
 * distribution): project discovery, file edit, compilation with xelatex
 * (Chinese + English via xeCJK), bibtex when a bibliography is present, PDF
 * preview, font installation, TeX package installation through tlmgr, and
 * LLM-assisted writing.
 *
 * Routes (all under `/latex`, registered by the plugin apply):
 *
 *  - `POST /latex/projects {cwd}` → directories under the workspace (depth ≤3)
 *                                    that contain .tex files, with their main candidates.
 *  - `POST /latex/list {cwd, dir}` → the project's file tree (bounded).
 *  - `POST /latex/read {cwd, dir, path}` → UTF-8 file content (2 MiB cap).
 *  - `POST /latex/write {cwd, dir, path, content}` → create/overwrite a project file
 *                                    (an empty `content` creates an empty file).
 *
 * `dir` selects the project directory (workspace-relative, '.' for the
 * workspace root); `path` is relative to that project directory, which is the
 * same base `list` reports its entries against.
 *  - `POST /latex/compile {cwd, dir, main}` → compile in a temp mirror (xelatex,
 *                                    bibtex when needed, extra passes), cache the
 *                                    PDF, delete the temp dir; on failure returns
 *                                    the extracted log excerpt.
 *  - `GET  /latex/pdf?cwd=&dir=&main=` → the cached PDF bytes (application/pdf).
 *  - `POST /latex/clean {cwd, dir}` → delete in-place build artifacts (*.aux/.log/...).
 *  - `POST /latex/fonts {cwd, dir, op}` → op=list (project fonts + package status),
 *                                    op=install (TTF/OTF into <project>/fonts/),
 *                                    op=install-package (tlmgr install <name>).
 *  - `POST /latex/ai {cwd, dir, path, selection?, instruction, model?}` → LLM writing
 *                                    assistant over the file (or a selection).
 *  - `GET  /latex/models` → the provider/model catalog the writing assistant can route to.
 *
 * The target directory is chosen per request from `cwd`, resolved against the
 * host's known workspace paths (same guard as the git panel); project `dir`
 * values are validated to stay inside the workspace. Responses are JSON;
 * errors carry an `error` field.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readdir, stat } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GitCwdResolver } from './git-service.ts'
import { normalizeSlashes } from './git-service.ts'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { listLlmModels, resolveLlmRoute } from './llm-route.ts'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_PDF_BYTES = 20 * 1024 * 1024
const MAX_FONT_BYTES = 20 * 1024 * 1024
/** Mirror bounds: a pathological project must not stall a compile. */
const MAX_PROJECT_FILES = 2000
const MAX_MIRROR_BYTES = 512 * 1024 * 1024
/** Per-file mirror bound (images and PDFs are larger than the editable source cap). */
const MAX_MIRROR_FILE_BYTES = 64 * 1024 * 1024
/** Extensions mirrored into the temp compile directory. */
const COPY_EXTS = new Set(['tex', 'bib', 'bst', 'sty', 'cls', 'png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff', 'pdf', 'mp4', 'ttf', 'otf', 'otc', 'ttc', 'eps', 'fig', 'dat', 'csv', 'xml', 'json', 'txt', 'md'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', '.svn', '.hg', '.git'])
/** In-place artifacts removed by /latex/clean. */
const CLEAN_EXTS = new Set(['aux', 'log', 'out', 'toc', 'bbl', 'blg', 'fls', 'fdb_latexmk', 'run.xml', 'synctex.gz', 'idx', 'ind'])
const FONT_EXTS = new Set(['ttf', 'otf', 'otc', 'ttc'])

// ---------------------------------------------------------------------------
// process execution
// ---------------------------------------------------------------------------

/**
 * Run one command with bounded output and a timeout.
 * @param command - executable (or a .bat/.cmd, which runs through the shell).
 * @param args - array arguments (shell-quoted only when `shell` is set).
 * @param cwd - working directory.
 * @param timeoutMs - kill deadline.
 * @returns stdout plus the exit code (non-zero tolerated; the caller interprets).
 * @throws on spawn failure, timeout, or an unbounded output.
 */
function runCommand(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; code: number }> {
  const shell = /\.(bat|cmd)$/i.test(command)
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...(shell ? { shell: true } : {}) })
    let stdout = ''
    let stderr = ''
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectRun(error)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      fail(new Error(`${command} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > 8 * 1024 * 1024) {
        child.kill('SIGKILL')
        fail(new Error(`${command} output too large`))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 8 * 1024 * 1024) {
        child.kill('SIGKILL')
        fail(new Error(`${command} output too large`))
      }
    })
    child.on('error', (error) => { fail(error) })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ stdout: `${stdout}\n${stderr}`, code: code ?? -1 })
    })
  })
}

/**
 * Resolve a TeX distribution executable: first by plain name (PATH), then by
 * probing the standard Windows TeX Live layout (both .exe and .bat forms).
 * @param name - executable name (e.g. xelatex, tlmgr, kpsewhich).
 * @returns the command string to spawn.
 * @throws when the executable is not found anywhere.
 */
async function findEngine(name: string): Promise<string> {
  try {
    await runCommand(name, ['--version'], process.cwd(), 10_000)
    return name
  } catch {
    let years: string[] = []
    try {
      years = readdirSync('C:/texlive').sort().reverse()
    } catch {
      years = []
    }
    for (const year of years) {
      for (const suffix of ['.exe', '.bat']) {
        const candidate = `C:/texlive/${year}/bin/windows/${name}${suffix}`
        try {
          await runCommand(candidate, ['--version'], process.cwd(), 10_000)
          return candidate
        } catch {
          // Try the next form / distribution year.
        }
      }
    }
    throw new Error(`latex panel: ${name} not found (install TeX Live or add it to PATH)`)
  }
}

/** The cached xelatex location (resolved once). */
let xelatexPath: string | undefined
async function xelatex(): Promise<string> {
  if (xelatexPath === undefined) {
    xelatexPath = await findEngine('xelatex')
  }
  return xelatexPath
}

/** The cached tlmgr location (resolved once). */
let tlmgrPath: string | undefined
async function tlmgr(): Promise<string> {
  if (tlmgrPath === undefined) {
    tlmgrPath = await findEngine('tlmgr')
  }
  return tlmgrPath
}

// ---------------------------------------------------------------------------
// request plumbing
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) { resolveBody({}); return }
      try {
        const value = JSON.parse(raw) as unknown
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          reject(new Error('latex panel: JSON body must be an object'))
          return
        }
        resolveBody(value as Record<string, unknown>)
      } catch (error) {
        reject(new Error(`latex panel: invalid JSON body: ${String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

function bodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`latex panel: body field "${field}" must be a non-empty string`)
  }
  return value
}

function bodyOptionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A string body field that may be empty (a newly created file has no content yet). */
function bodyText(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string') {
    throw new Error(`latex panel: body field "${field}" must be a string`)
  }
  return value
}

/** Validate a project-relative path and resolve it against the project directory. */
function resolveProjectPath(projectDir: string, filePath: string): string {
  if (filePath.includes('..') || filePath.startsWith('/') || filePath.startsWith('\\')) {
    throw new Error('latex panel: invalid path')
  }
  const abs = resolve(join(projectDir, filePath))
  const root = resolve(projectDir)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error('latex panel: path escapes the project')
  }
  return abs
}

/** Validate a project directory and resolve it against the workspace. */
function resolveProjectDir(workspace: string, dir: string): string {
  const abs = resolve(join(workspace, dir))
  const root = resolve(workspace)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error('latex panel: project directory escapes the workspace')
  }
  return abs
}

// ---------------------------------------------------------------------------
// project discovery + file tree
// ---------------------------------------------------------------------------

/**
 * Discover LaTeX projects: directories up to depth 3 that directly contain at
 * least one .tex file.
 * @param workspace - the workspace root.
 * @returns the projects with their main-file candidates.
 */
export async function findProjects(workspace: string): Promise<readonly { path: string; name: string; mainFiles: string[] }[]> {
  const projects: { path: string; name: string; mainFiles: string[] }[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: workspace, depth: 0 }]
  while (queue.length > 0) {
    const item = queue.shift() as { dir: string; depth: number }
    let entries
    try {
      entries = await readdir(item.dir, { withFileTypes: true })
    } catch {
      continue
    }
    const texFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.tex')).map(e => e.name)
    if (texFiles.length > 0) {
      const rel = relative(workspace, item.dir)
      projects.push({ path: rel === '' ? '.' : normalizeSlashes(rel), name: rel === '' ? basename(workspace) : basename(item.dir), mainFiles: texFiles.sort() })
    }
    if (item.depth >= 3) continue
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      queue.push({ dir: join(item.dir, entry.name), depth: item.depth + 1 })
    }
  }
  return projects.slice(0, 100)
}

/**
 * List the project's files (depth ≤ 3, bounded) for the file tree.
 * @param projectDir - absolute project directory.
 * @returns relative paths with sizes.
 */
export async function listProjectFiles(projectDir: string): Promise<readonly { path: string; size: number; dir: boolean }[]> {
  const files: { path: string; size: number; dir: boolean }[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: projectDir, depth: 0 }]
  while (queue.length > 0 && files.length < 500) {
    const item = queue.shift() as { dir: string; depth: number }
    let entries
    try {
      entries = await readdir(item.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= 500) break
      const rel = normalizeSlashes(relative(projectDir, join(item.dir, entry.name)))
      if (entry.isDirectory()) {
        files.push({ path: rel, size: 0, dir: true })
        if (item.depth < 3 && !SKIP_DIRS.has(entry.name)) {
          queue.push({ dir: join(item.dir, entry.name), depth: item.depth + 1 })
        }
      } else {
        try {
          const fileStat = await stat(join(item.dir, entry.name))
          files.push({ path: rel, size: fileStat.size, dir: false })
        } catch {
          files.push({ path: rel, size: 0, dir: false })
        }
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

// ---------------------------------------------------------------------------
// compilation
// ---------------------------------------------------------------------------

/** Cached PDFs: `${dir}::${main}` → bytes (bounded map, oldest evicted). */
const pdfCache = new Map<string, { bytes: Buffer; at: number }>()
const MAX_CACHE_ENTRIES = 10
/** In-flight compiles per project key (one at a time). */
const compiling = new Set<string>()

function cacheKey(projectDir: string, main: string): string {
  return `${normalizeSlashes(projectDir)}::${main}`
}

/** Mirror the project's compilable files into a temp directory.
 * @param projectDir - absolute project directory.
 * @param tmp - the compile mirror directory.
 * @returns the project-relative files that were skipped, so a failing compile
 *   can say whether a missing reference exists in the project.
 */
async function mirrorProject(projectDir: string, tmp: string): Promise<string[]> {
  const queue: string[] = [projectDir]
  const skipped: string[] = []
  let copied = 0
  let bytes = 0
  while (queue.length > 0) {
    const dir = queue.shift() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const src = join(dir, entry.name)
      const rel = normalizeSlashes(relative(projectDir, src))
      if (await isDirectoryEntry(src, entry)) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(src)
        continue
      }
      const dot = entry.name.lastIndexOf('.')
      if (dot < 0 || !COPY_EXTS.has(entry.name.slice(dot + 1).toLowerCase())) continue
      if (copied >= MAX_PROJECT_FILES || bytes >= MAX_MIRROR_BYTES) {
        skipped.push(rel)
        continue
      }
      let buffer: Buffer
      try {
        buffer = await readFile(src)
      } catch {
        skipped.push(rel)
        continue
      }
      if (buffer.length > MAX_MIRROR_FILE_BYTES) {
        skipped.push(rel)
        continue
      }
      const dest = join(tmp, relative(projectDir, src))
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, buffer)
      copied += 1
      bytes += buffer.length
    }
  }
  return skipped
}

/** Whether one directory entry is a directory, following a symbolic link. */
async function isDirectoryEntry(src: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  const target = await stat(src).catch(() => undefined)
  return target?.isDirectory() === true
}

/**
 * Explain the files a failed compile could not find: whether the project holds
 * them at all, or the compile mirror skipped them.
 * @param log - the extracted log excerpt.
 * @param skipped - project-relative files the mirror did not copy.
 * @param projectDir - absolute project directory.
 * @returns a diagnostic block, or an empty string when nothing is missing.
 */
export function explainMissingReferences(log: string, skipped: readonly string[], projectDir: string): string {
  const names = new Set<string>()
  for (const match of log.matchAll(/(?:File `([^']+)' not found|Unable to load picture or PDF file '([^']+)')/g)) {
    const name = match[1] ?? match[2]
    if (name !== undefined && name.length > 0) names.add(normalizeSlashes(name))
  }
  if (names.size === 0) return ''
  const lines: string[] = []
  for (const name of names) {
    if (skipped.includes(name)) {
      lines.push(`latex panel: ${name} is in the project but was not mirrored (file-count or size limit reached)`)
      continue
    }
    const located = locateProjectFile(projectDir, name)
    if (located !== undefined) {
      lines.push(`latex panel: ${name} is in the project at ${located}; the document resolves it from somewhere else`)
    } else {
      lines.push(`latex panel: ${name} is not in the project directory — generate it first (figures produced by scripts or external tools are not built by this panel)`)
    }
  }
  return `\n\n${lines.join('\n')}`
}

/** Locate a referenced file by relative path or basename inside the project. */
function locateProjectFile(projectDir: string, name: string): string | undefined {
  if (existsSync(join(projectDir, name))) return name
  const base = basename(name)
  const queue: { dir: string; depth: number }[] = [{ dir: projectDir, depth: 0 }]
  while (queue.length > 0) {
    const item = queue.shift() as { dir: string; depth: number }
    let entries
    try {
      entries = readdirSync(item.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === base && !entry.isDirectory()) {
        return normalizeSlashes(relative(projectDir, join(item.dir, entry.name)))
      }
      if (item.depth < 3 && (entry.isDirectory() || entry.isSymbolicLink()) && !SKIP_DIRS.has(entry.name)) {
        queue.push({ dir: join(item.dir, entry.name), depth: item.depth + 1 })
      }
    }
  }
  return undefined
}

/**
 * Extract a readable excerpt from a LaTeX log: the context around the first
 * `!` error line, falling back to the log tail.
 * @param log - the full .log content.
 * @returns at most 40 lines.
 */
export function extractLogExcerpt(log: string): string {
  const lines = log.split('\n')
  const errIdx = lines.findIndex(l => l.startsWith('!'))
  if (errIdx >= 0) {
    return lines.slice(Math.max(0, errIdx - 4), errIdx + 24).join('\n')
  }
  return lines.slice(-30).join('\n')
}

/**
 * Compile one main file: mirror → xelatex → (bibtex when a .bib is referenced)
 * → two more xelatex passes. The temp dir is always deleted; on success the
 * PDF is cached for `/latex/pdf`.
 * @param projectDir - absolute project directory.
 * @param main - project-relative main .tex path.
 * @returns ok plus the PDF size, or the log excerpt on failure.
 */
export async function compileProject(
  projectDir: string,
  main: string,
): Promise<{ ok: true; size: number } | { ok: false; log: string }> {
  const key = cacheKey(projectDir, main)
  if (compiling.has(key)) {
    throw new Error('latex panel: a compile for this project is already running')
  }
  compiling.add(key)
  const engine = await xelatex()
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-latex-'))
  try {
    const skipped = await mirrorProject(projectDir, tmp)
    const mainRel = normalizeSlashes(main)
    const mainBase = basename(mainRel).replace(/\.tex$/, '')
    const mainDir = dirname(mainRel)
    const auxPath = join(tmp, mainDir, `${mainBase}.aux`)
    /** Report a failed pass with the log excerpt and a missing-reference diagnosis. */
    const fail = (log: string): { ok: false; log: string } => ({
      ok: false,
      log: `${log}${explainMissingReferences(log, skipped, projectDir)}`,
    })
    // First pass: detect whether a bibliography is present.
    const first = await runCommand(engine, ['-interaction=nonstopmode', '-halt-on-error', mainRel], tmp, 180_000)
    if (first.code !== 0) {
      const log = await readFile(join(tmp, mainDir, `${mainBase}.log`), 'utf8').catch(() => '')
      return fail(extractLogExcerpt(log || first.stdout))
    }
    let useBibtex = false
    try {
      const aux = await readFile(auxPath, 'utf8')
      useBibtex = aux.includes('\\bibdata{')
    } catch {
      useBibtex = false
    }
    if (useBibtex) {
      const bibtex = await runCommand('bibtex', [mainBase], tmp, 60_000)
      if (bibtex.code !== 0) {
        const log = await readFile(join(tmp, mainDir, `${mainBase}.blg`), 'utf8').catch(() => '')
        return fail(extractLogExcerpt(log || bibtex.stdout))
      }
    }
    for (let pass = 0; pass < 2; pass += 1) {
      const next = await runCommand(engine, ['-interaction=nonstopmode', '-halt-on-error', mainRel], tmp, 180_000)
      if (next.code !== 0) {
        const log = await readFile(join(tmp, mainDir, `${mainBase}.log`), 'utf8').catch(() => '')
        return fail(extractLogExcerpt(log || next.stdout))
      }
    }
    const pdfPath = join(tmp, mainDir, `${mainBase}.pdf`)
    const bytes = await readFile(pdfPath)
    if (bytes.length === 0) return { ok: false, log: 'latex panel: empty PDF produced' }
    if (bytes.length > MAX_PDF_BYTES) return { ok: false, log: 'latex panel: PDF exceeds 20 MiB' }
    pdfCache.set(key, { bytes, at: Date.now() })
    if (pdfCache.size > MAX_CACHE_ENTRIES) {
      let oldest: string | undefined
      let oldestAt = Number.MAX_SAFE_INTEGER
      for (const [k, v] of pdfCache) {
        if (v.at < oldestAt) {
          oldest = k
          oldestAt = v.at
        }
      }
      if (oldest !== undefined) pdfCache.delete(oldest)
    }
    return { ok: true, size: bytes.length }
  } finally {
    compiling.delete(key)
    await rm(tmp, { recursive: true, force: true }).catch(() => {
      // The temp dir is best-effort cleanup; the OS temp policy owns it.
    })
  }
}

// ---------------------------------------------------------------------------
// fonts
// ---------------------------------------------------------------------------

/** TeX packages the panel cares about (kpsewhich probe). */
async function probePackage(engine: string, file: string): Promise<boolean> {
  const candidates = ['kpsewhich', `${dirname(engine)}kpsewhich.exe`]
  for (const candidate of candidates) {
    try {
      const res = await runCommand(candidate, [file], process.cwd(), 10_000)
      if (res.stdout.trim().length > 0) return true
      if (res.code === 0) return false
    } catch {
      // Try the next candidate.
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// AI writing
// ---------------------------------------------------------------------------

/**
 * LLM writing assistant over a project file: the file (or a selection) plus
 * the user instruction go in, the model returns LaTeX code.
 * @param ctx - the Host context providing the llm service.
 * @param model - the model id or display name the client picked, when it picked one.
 * @param fileContent - the file content the instruction applies to.
 * @param selection - the editor selection to rewrite, when the user selected text.
 * @param instruction - the user's writing instruction.
 * @returns the model's LaTeX output.
 */
export async function aiWrite(
  ctx: Context,
  model: string | undefined,
  fileContent: string,
  selection: string | undefined,
  instruction: string,
): Promise<string> {
  const route = await resolveLlmRoute(ctx, model)
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system: 'You are a LaTeX writing assistant. Given LaTeX source and an instruction, return the revised or newly written LaTeX code only — no explanations, no code fences.',
    messages: [createUserMessage({
      content: [{
        type: 'text',
        text: selection !== undefined
          ? `LaTeX selection:\n${selection}\n\nInstruction:\n${instruction}`
          : `LaTeX source:\n${fileContent}\n\nInstruction:\n${instruction}`,
      }],
      source: { kind: 'plugin', plugin: 'dsh-client-ui-polish' },
    })],
    temperature: 0.2,
  })
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  const text = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => (block as { text: string }).text)
    .join('')
    .trim()
  if (text.length === 0) throw new Error('latex panel: the model returned an empty result')
  return text
}

// ---------------------------------------------------------------------------
// route handler
// ---------------------------------------------------------------------------

/**
 * Handle one `/latex` request.
 * @param resolveCwd - workspace-path resolver (see {@link GitCwdResolver}).
 * @param ctx - the Host context (llm service for `/latex/ai`).
 * @param req - incoming HTTP request.
 * @param res - server response.
 */
export async function handleLatexRequest(
  resolveCwd: GitCwdResolver,
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://latex-panel')
  const path = url.pathname
  const method = req.method ?? 'GET'
  try {
    if (method === 'POST' && path === '/latex/projects') {
      const body = await readJson(req)
      const workspace = resolveCwd(bodyString(body, 'cwd'))
      json(res, 200, { projects: await findProjects(workspace) })
      return
    }

    if (method === 'POST' && path === '/latex/list') {
      const body = await readJson(req)
      const workspace = resolveCwd(bodyString(body, 'cwd'))
      const projectDir = resolveProjectDir(workspace, bodyOptionalString(body, 'dir') ?? '.')
      json(res, 200, { files: await listProjectFiles(projectDir) })
      return
    }

    if (method === 'POST' && path === '/latex/read') {
      const body = await readJson(req)
      const workspace = resolveCwd(bodyString(body, 'cwd'))
      const projectDir = resolveProjectDir(workspace, bodyOptionalString(body, 'dir') ?? '.')
      const abs = resolveProjectPath(projectDir, bodyString(body, 'path'))
      const buffer = await readFile(abs)
      if (buffer.length > MAX_FILE_BYTES) throw new Error('latex panel: file too large to edit')
      json(res, 200, { content: buffer.toString('utf8') })
      return
    }

    if (method === 'POST' && path === '/latex/write') {
      const body = await readJson(req)
      const workspace = resolveCwd(bodyString(body, 'cwd'))
      const projectDir = resolveProjectDir(workspace, bodyOptionalString(body, 'dir') ?? '.')
      const abs = resolveProjectPath(projectDir, bodyString(body, 'path'))
      const content = bodyText(body, 'content')
      if (content.length > MAX_FILE_BYTES) throw new Error('latex panel: file too large to save')
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      json(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/latex/compile') {
      const body = await readJson(req)
      const workspace = resolveCwd(bodyString(body, 'cwd'))
      const projectDir = resolveProjectDir(workspace, bodyOptionalString(body, 'dir') ?? '.')
      const main = bodyString(body, 'main')
      if (!main.toLowerCase().endsWith('.tex')) throw new Error('latex panel: main must be a .tex file')
      json(res, 200, await compileProject(projectDir, main))
      return
    }

    if (method === 'GET' && path === '/latex/pdf') {
      const workspace = resolveCwd(url.searchParams.get('cwd') ?? '')
      const dir = url.searchParams.get('dir') ?? '.'
      const main = url.searchParams.get('main') ?? ''
      if (main.length === 0) throw new Error('latex panel: /latex/pdf needs main')
      const projectDir = resolveProjectDir(workspace, dir)
      const cached = pdfCache.get(cacheKey(projectDir, main))
      if (cached === undefined) {
        json(res, 404, { error: 'latex panel: no compiled PDF yet' })
        return
      }
      res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store' })
      res.end(cached.bytes)
      return
    }

    if (method === 'POST' && path === '/latex/clean') {
      const body = await readJson(req)
      const workspace = resolveCwd(bodyString(body, 'cwd'))
      const projectDir = resolveProjectDir(workspace, bodyOptionalString(body, 'dir') ?? '.')
      const queue: string[] = [projectDir]
      let removed = 0
      while (queue.length > 0) {
        const dir = queue.shift() as string
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          const abs = join(dir, entry.name)
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) queue.push(abs)
            continue
          }
          const dot = entry.name.lastIndexOf('.')
          if (dot < 0) continue
          if (CLEAN_EXTS.has(entry.name.slice(dot + 1).toLowerCase())) {
            await rm(abs)
            removed += 1
          }
        }
      }
      json(res, 200, { ok: true, removed })
      return
    }

    if (method === 'POST' && path === '/latex/fonts') {
      const body = await readJson(req)
      const workspace = resolveCwd(bodyString(body, 'cwd'))
      const projectDir = resolveProjectDir(workspace, bodyOptionalString(body, 'dir') ?? '.')
      const op = bodyString(body, 'op')
      if (op === 'list') {
        const fontsDir = join(projectDir, 'fonts')
        let projectFonts: string[] = []
        try {
          projectFonts = (await readdir(fontsDir)).filter((name) => {
            const dot = name.lastIndexOf('.')
            return dot >= 0 && FONT_EXTS.has(name.slice(dot + 1).toLowerCase())
          }).sort()
        } catch {
          projectFonts = []
        }
        const engine = await xelatex()
        json(res, 200, {
          fonts: projectFonts,
          packages: {
            ctex: await probePackage(engine, 'ctex.sty'),
            xecjk: await probePackage(engine, 'xeCJK.sty'),
            fandol: await probePackage(engine, 'FandolSong-Regular.otf'),
          },
        })
        return
      }
      if (op === 'install') {
        const name = bodyString(body, 'name')
        const dot = name.lastIndexOf('.')
        if (dot < 0 || !FONT_EXTS.has(name.slice(dot + 1).toLowerCase())) {
          throw new Error('latex panel: font must be a .ttf/.otf/.otc/.ttc file')
        }
        if (name.includes('/') || name.includes('\\') || name.includes('..') || name.length > 128) {
          throw new Error('latex panel: invalid font name')
        }
        const data = bodyString(body, 'data')
        const buffer = Buffer.from(data, 'base64')
        if (buffer.length === 0 || buffer.length > MAX_FONT_BYTES) {
          throw new Error('latex panel: font data is empty or exceeds 20 MiB')
        }
        const fontsDir = join(projectDir, 'fonts')
        await mkdir(fontsDir, { recursive: true })
        await writeFile(join(fontsDir, name), buffer)
        json(res, 200, { ok: true, path: `fonts/${name}` })
        return
      }
      if (op === 'install-package') {
        const name = bodyString(body, 'name')
        if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name)) {
          throw new Error('latex panel: invalid tlmgr package name')
        }
        const tool = await tlmgr()
        const out = await runCommand(tool, ['install', name], dirname(tool), 300_000)
        if (out.code !== 0) throw new Error(`tlmgr install ${name} failed: ${out.stdout.slice(-1000)}`)
        json(res, 200, { ok: true, log: out.stdout.slice(-1000) })
        return
      }
      throw new Error('latex panel: fonts op must be list, install, or install-package')
    }

    if (method === 'POST' && path === '/latex/ai') {
      const body = await readJson(req)
      const workspace = resolveCwd(bodyString(body, 'cwd'))
      const projectDir = resolveProjectDir(workspace, bodyOptionalString(body, 'dir') ?? '.')
      const rel = bodyString(body, 'path')
      const abs = resolve(join(projectDir, rel))
      if (!abs.startsWith(resolve(projectDir) + sep)) {
        throw new Error('latex panel: path escapes the project')
      }
      const fileContent = await readFile(abs, 'utf8').catch(() => '')
      const instruction = bodyString(body, 'instruction')
      const selection = bodyOptionalString(body, 'selection')
      const model = bodyOptionalString(body, 'model')
      const text = await aiWrite(ctx, model, fileContent.slice(0, 60_000), selection, instruction)
      json(res, 200, { text })
      return
    }

    if (method === 'GET' && path === '/latex/models') {
      json(res, 200, { models: await listLlmModels(ctx) })
      return
    }

    json(res, 404, { error: `latex panel: unknown route ${method} ${path}` })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!res.headersSent) {
      json(res, 500, { error: message })
    } else if (!res.writableEnded) {
      res.end()
    }
  }
}
