// Host process and machine sampler behind the stats float's runtime section.
// The probe keeps the previous CPU reading so each sample reports the CPU used
// over the interval since the last one; the route answers one JSON sample per
// request and the browser polls it while the card is expanded.

import { cpus, freemem, loadavg, totalmem } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProcessStats } from './types.ts'

/** Write a JSON response with the given status code. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Create a sampler that reports process CPU over the interval between calls.
 * The first call measures since the probe was created, so a freshly expanded
 * card shows the plugin's own lifetime average rather than a spike.
 * @returns the sampler.
 */
export function createProcessStatsProbe(): () => ProcessStats {
  let previousCpu = process.cpuUsage()
  let previousAt = Date.now()
  return () => {
    const now = Date.now()
    const cpu = process.cpuUsage()
    // cpuUsage reports microseconds; the wall interval converts to the same
    // unit so the ratio is a percentage of one core.
    const elapsedMicros = Math.max(1, (now - previousAt) * 1_000)
    const cpuPercent = Math.max(
      0,
      (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / elapsedMicros * 100,
    )
    previousCpu = cpu
    previousAt = now
    const memory = process.memoryUsage()
    const load = loadavg()
    return {
      pid: process.pid,
      cpuPercent,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      uptimeSeconds: Math.round(process.uptime()),
      system: {
        cpuCount: cpus().length,
        load1: load[0] as number,
        load5: load[1] as number,
        load15: load[2] as number,
        totalMemBytes: totalmem(),
        freeMemBytes: freemem(),
      },
      sampledAt: now,
    }
  }
}

/**
 * Handle one `/stats/process` request.
 * @param probe - the sampler serving the response.
 * @param req - incoming HTTP request.
 * @param res - server response.
 */
export function handleProcessStatsRequest(
  probe: () => ProcessStats,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = new URL(req.url ?? '/', 'http://ui-polish')
  if ((req.method ?? 'GET') !== 'GET' || url.pathname !== '/stats/process') {
    json(res, 404, { error: 'ui-polish: unknown stats route' })
    return
  }
  json(res, 200, probe())
}
