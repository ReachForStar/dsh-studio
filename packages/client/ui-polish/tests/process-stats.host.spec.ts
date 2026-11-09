/** Process stats route: sampler shape and the JSON response lifecycle. */
import { describe, expect, it } from 'vitest'
import { createProcessStatsProbe, handleProcessStatsRequest } from '../src/process-stats.ts'

/** In-memory response double capturing status and body. */
function responseDouble() {
  let statusCode = 0
  let body = ''
  return {
    res: {
      writeHead(status: number) { statusCode = status },
      end(payload?: string) { body += payload ?? '' },
    },
    get status(): number { return statusCode },
    get json(): Record<string, unknown> { return JSON.parse(body) as Record<string, unknown> },
  }
}

/** Minimal request double: URL + method. */
function requestDouble(path: string, method: string) {
  return { url: path, method }
}

describe('createProcessStatsProbe', () => {
  it('samples the process and the machine', () => {
    const probe = createProcessStatsProbe()
    const sample = probe()

    expect(sample.pid).toBe(process.pid)
    expect(Number.isFinite(sample.cpuPercent)).toBe(true)
    expect(sample.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(sample.rssBytes).toBeGreaterThan(0)
    expect(sample.heapUsedBytes).toBeGreaterThan(0)
    expect(sample.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(sample.system.cpuCount).toBeGreaterThan(0)
    expect(sample.system.load1).toBeGreaterThanOrEqual(0)
    expect(sample.system.totalMemBytes).toBeGreaterThan(0)
    expect(sample.system.freeMemBytes).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(sample.sampledAt)).toBe(true)
  })

  it('reports the CPU used since the previous sample', () => {
    const probe = createProcessStatsProbe()
    probe()
    const second = probe()

    expect(second.cpuPercent).toBeGreaterThanOrEqual(0)
  })
})

describe('handleProcessStatsRequest', () => {
  it('answers one JSON sample', () => {
    const double = responseDouble()
    const sample = {
      pid: 1, cpuPercent: 2, rssBytes: 3, heapUsedBytes: 4, uptimeSeconds: 5,
      system: { cpuCount: 8, load1: 0, load5: 0, load15: 0, totalMemBytes: 100, freeMemBytes: 40 },
      sampledAt: 6,
    }
    handleProcessStatsRequest(
      () => sample,
      requestDouble('/stats/process', 'GET') as never,
      double.res as never,
    )

    expect(double.status).toBe(200)
    expect(double.json).toEqual(sample)
  })

  it('rejects another path or method with 404', () => {
    const wrongPath = responseDouble()
    handleProcessStatsRequest(
      () => ({}) as never,
      requestDouble('/stats/other', 'GET') as never,
      wrongPath.res as never,
    )
    expect(wrongPath.status).toBe(404)
    expect(wrongPath.json).toEqual({ error: 'ui-polish: unknown stats route' })

    const wrongMethod = responseDouble()
    handleProcessStatsRequest(
      () => ({}) as never,
      requestDouble('/stats/process', 'POST') as never,
      wrongMethod.res as never,
    )
    expect(wrongMethod.status).toBe(404)
  })

  it('treats a missing method as GET', () => {
    const double = responseDouble()
    handleProcessStatsRequest(
      () => ({ pid: 1 }) as never,
      { url: '/stats/process' } as never,
      double.res as never,
    )
    expect(double.status).toBe(200)
  })

  it('treats a missing url as the root path', () => {
    const double = responseDouble()
    handleProcessStatsRequest(
      () => ({}) as never,
      { method: 'GET' } as never,
      double.res as never,
    )
    expect(double.status).toBe(404)
  })
})
