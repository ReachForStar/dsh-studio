/** ui-polish node half: the git/latex/background/scene/process routes it mounts on the webserver. */
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebResourceRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as polish from '../src/index.ts'

/** One captured route registration plus its disposer call count. */
interface MountedRoute {
  route: WebRoute | WebResourceRoute
  dispose: ReturnType<typeof vi.fn>
}

/** In-memory response double capturing status and the JSON error text. */
function responseDouble() {
  let statusCode = 0
  let body = ''
  return {
    res: {
      writableEnded: false,
      writeHead(status: number) { statusCode = status },
      end(payload?: string) { body += payload ?? '' },
    },
    get status(): number { return statusCode },
    get error(): string | undefined {
      const value = (JSON.parse(body) as Record<string, unknown>)['error']
      return typeof value === 'string' ? value : undefined
    },
  }
}

/** Minimal request double: URL + method. */
function requestDouble(url: string, method: string) {
  return { url, method, headers: {} }
}

describe('ui-polish host routes', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
  })

  it('registers every panel route on the webserver and unwinds them on dispose', async () => {
    ctx = new Context()
    const routes: MountedRoute[] = []
    const releaseSettings = vi.fn()
    const configure = vi.fn((_policy: { auto: boolean }) => releaseSettings)
    ctx.provide('settings', { configure } as never)
    ctx.provide('llm', {} as never)
    ctx.provide('webServer', {
      register: (route: WebRoute | WebResourceRoute) => {
        const dispose = vi.fn()
        routes.push({ route, dispose })
        return dispose
      },
    } as never)

    const fiber = ctx.plugin(polish)
    await fiber.await()

    expect(routes.map(({ route }) => `${route.kind} ${route.path}`)).toEqual([
      'prefix /git',
      'prefix /latex',
      'prefix /bg',
      'prefix /scene',
      'exact /stats/process',
    ])
    // The preferences live on the volatile Config and the browser half ships
    // custom rows, so the host half keeps its fiber off the generated pages.
    expect(configure.mock.calls[0]?.[0]).toEqual({ auto: false })

    // Each handler is invoked once through its unknown-route branch: the panel
    // services own the per-route behavior and are exercised by their own specs.
    const answers: Record<string, string> = {}
    for (const { route } of routes) {
      if (!('handler' in route)) continue
      const double = responseDouble()
      const url = route.kind === 'exact' ? route.path : `${route.path}/unknown`
      await route.handler(
        requestDouble(url, 'GET') as never,
        double.res as never,
      )
      answers[route.path] = `${double.status} ${double.error ?? ''}`
    }
    for (const path of ['/git', '/latex', '/scene']) {
      expect(answers[path]).toMatch(/^404 .*unknown route/)
    }
    expect(answers['/bg']).toMatch(/^404 .*unknown route/)
    expect(answers['/stats/process']).toMatch(/^200 /)

    await fiber.dispose()
    for (const { dispose } of routes) expect(dispose).toHaveBeenCalledOnce()
    expect(releaseSettings).toHaveBeenCalledOnce()
  })

  it('resolves the request cwd through the live workspace registry', async () => {
    ctx = new Context()
    const list = vi.fn(() => [{ path: '/workspace/one' }])
    const routes: MountedRoute[] = []
    ctx.provide('settings', { configure: vi.fn(() => vi.fn()) } as never)
    ctx.provide('llm', {} as never)
    ctx.provide('workspaceRegistry', { list } as never)
    ctx.provide('webServer', {
      register: (route: WebRoute | WebResourceRoute) => {
        const dispose = vi.fn()
        routes.push({ route, dispose })
        return dispose
      },
    } as never)

    const fiber = ctx.plugin(polish)
    await fiber.await()
    const scene = routes.find(({ route }) => route.path === '/scene')?.route
    if (scene === undefined || !('handler' in scene)) throw new Error('scene route missing')
    const double = responseDouble()
    await scene.handler(requestDouble('/scene/unknown', 'GET') as never, double.res as never)

    expect(list).toHaveBeenCalledOnce()
    expect(double.status).toBe(404)
    await fiber.dispose()
  })
})
