// LaTeX panel HTTP client: typed fetch helpers for the /latex/* routes.

/** One discovered LaTeX project. */
export interface LatexProject {
  /** Workspace-relative project directory ('.' for the root itself). */
  path: string
  name: string
  /** Main-file candidates (.tex files directly in the project dir). */
  mainFiles: readonly string[]
}

/** One entry of the project file tree. */
export interface LatexFile {
  path: string
  size: number
  dir: boolean
}

/** `/latex/compile` result. */
export interface LatexCompileResult {
  ok: boolean
  size?: number
  log?: string
  /** Names the compile copied into its mirror from elsewhere in the workspace. */
  supplied?: readonly string[]
}

/** `/latex/fonts` list result. */
export interface LatexFontStatus {
  fonts: readonly string[]
  packages: { ctex: boolean; xecjk: boolean; fandol: boolean }
}

/** One model the writing assistant can route to. */
export interface LatexModel {
  provider: string
  model: string
  name: string
}

/** One earlier turn of a writing conversation. */
export interface LatexAiTurn {
  role: 'user' | 'assistant'
  text: string
}

/**
 * Query-encode the workspace into a `/latex` URL.
 * @param path - route path.
 * @param cwd - workspace directory carried as the `cwd` query parameter.
 * @param params - additional query parameters.
 * @returns the URL with the query string attached.
 */
export function latexUrl(path: string, cwd: string, params?: Record<string, string>): string {
  const search = new URLSearchParams({ cwd })
  for (const [key, value] of Object.entries(params ?? {})) search.set(key, value)
  return `${path}?${search.toString()}`
}

/**
 * Call a `/latex` JSON route (all JSON routes are POST with a JSON body).
 * @param path - route path.
 * @param cwd - workspace directory.
 * @param body - optional JSON body.
 * @returns the parsed JSON payload.
 * @throws {Error} with the body `error` message when the response is not ok.
 */
export async function latexCall<T>(path: string, cwd: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, ...(body ?? {}) }),
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `latex panel: HTTP ${response.status}`)
  }
  return payload as unknown as T
}

/**
 * Stream one writing turn from `/latex/ai` (NDJSON): deltas arrive through
 * `onText` as the model produces them, the promise resolves with the full
 * output, and it rejects on an error event or a transport failure.
 * @param cwd - workspace directory.
 * @param dir - project directory relative to the workspace.
 * @param path - project-relative file path.
 * @param selection - the editor selection to rewrite, when the user selected text.
 * @param instruction - the instruction for this turn.
 * @param history - earlier turns of this writing session, oldest first.
 * @param token - client token for the cancel route.
 * @param onText - called with each text delta as it arrives.
 * @param model - optional model hint.
 * @returns the model's LaTeX output.
 * @throws {Error} when the stream reports an error or closes without a result.
 */
export async function aiStream(
  cwd: string,
  dir: string,
  path: string,
  selection: string | undefined,
  instruction: string,
  history: readonly LatexAiTurn[],
  token: string,
  onText: (delta: string) => void,
  model?: string,
): Promise<string> {
  const response = await fetch('/latex/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cwd,
      dir,
      path,
      token,
      instruction,
      history: [...history],
      ...(selection !== undefined ? { selection } : {}),
      ...(model !== undefined ? { model } : {}),
    }),
  })
  if (!response.ok || response.body === null) {
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    throw new Error(typeof payload.error === 'string' ? payload.error : `latex panel: HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let collected = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length === 0) continue
      const event = JSON.parse(line) as { t: string; x?: string; m?: string; e?: string }
      if (event.t === 'text' && typeof event.x === 'string') {
        collected += event.x
        onText(event.x)
      } else if (event.t === 'done') {
        return event.m ?? collected
      } else if (event.t === 'stop') {
        return collected
      } else if (event.t === 'err') {
        throw new Error(event.e ?? 'latex panel: writing failed')
      }
    }
  }
  throw new Error('latex panel: the writing stream closed without a result')
}
/**
 * Call a GET `/latex` route that carries no workspace (the model catalog).
 * @param path - route path.
 * @returns the parsed JSON payload.
 * @throws {Error} with the body `error` message when the response is not ok.
 */
async function latexGet<T>(path: string): Promise<T> {
  const response = await fetch(path)
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `latex panel: HTTP ${response.status}`)
  }
  return payload as unknown as T
}

/** The fetch surface used by the panel. */
export const latexApi = {
  projects: (cwd: string): Promise<{ projects: readonly LatexProject[] }> =>
    latexCall('/latex/projects', cwd),
  list: (cwd: string, dir: string): Promise<{ files: readonly LatexFile[] }> =>
    latexCall('/latex/list', cwd, { dir }),
  read: (cwd: string, dir: string, path: string): Promise<{ content: string }> =>
    latexCall('/latex/read', cwd, { dir, path }),
  write: (cwd: string, dir: string, path: string, content: string): Promise<{ ok: boolean }> =>
    latexCall('/latex/write', cwd, { dir, path, content }),
  compile: (cwd: string, dir: string, main: string): Promise<LatexCompileResult> =>
    latexCall('/latex/compile', cwd, { dir, main }),
  /** The cached PDF URL for the iframe (404 before the first compile). */
  pdfUrl: (cwd: string, dir: string, main: string, tick: number): string =>
    latexUrl('/latex/pdf', cwd, { dir, main, t: String(tick) }),
  clean: (cwd: string, dir: string): Promise<{ ok: boolean; removed: number }> =>
    latexCall('/latex/clean', cwd, { dir }),
  /** The provider/model catalog the writing assistant routes through. */
  models: (): Promise<{ models: readonly LatexModel[] }> => latexGet('/latex/models'),
  fontList: (cwd: string, dir: string): Promise<LatexFontStatus> =>
    latexCall('/latex/fonts', cwd, { dir, op: 'list' }),
  fontInstall: (cwd: string, dir: string, name: string, data: string): Promise<{ ok: boolean; path: string }> =>
    latexCall('/latex/fonts', cwd, { dir, op: 'install', name, data }),
  fontInstallPackage: (cwd: string, dir: string, name: string): Promise<{ ok: boolean; log: string }> =>
    latexCall('/latex/fonts', cwd, { dir, op: 'install-package', name }),
  ai: aiStream,
  /** Abort a running writing request. */
  aiCancel: (token: string): Promise<{ ok: boolean }> => latexCall('/latex/ai-cancel', '', { token }),
}
