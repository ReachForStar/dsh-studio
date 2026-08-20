// Shared git-panel HTTP client: plain fetch helpers for the /git/* routes.
// Used by both the Git view tab and the file view tab.

/** Query-encode the cwd into a `/git` URL.
 * @param path - route path (e.g. `/git/list`).
 * @param cwd - workspace directory carried as the `cwd` query parameter.
 * @param params - additional query parameters.
 * @returns the URL with the query string attached.
 */
export function gitUrl(path: string, cwd: string, params?: Record<string, string>): string {
  const search = new URLSearchParams({ cwd, ...params })
  return `${path}?${search.toString()}`
}

/** Fetch JSON from a git panel endpoint, throwing on HTTP or body errors.
 * @param path - route path (e.g. `/git/read`).
 * @param cwd - workspace directory the host resolves the request against.
 * @param init - fetch options; a JSON string body is merged with the cwd.
 * @returns the parsed JSON payload.
 * @throws {Error} when the response is not ok, with the body `error` message when present.
 */
export async function gitFetch<T>(path: string, cwd: string, init?: RequestInit): Promise<T> {
  const body = init?.body
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json')
  const response = await fetch(gitUrl(path, cwd), {
    ...(init ?? {}),
    headers,
    ...typeof body === 'string' ? { body: JSON.stringify({ ...JSON.parse(body), cwd }) } : {},
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `git panel: HTTP ${response.status}`)
  }
  return payload as unknown as T
}
