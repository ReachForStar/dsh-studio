/** Wire types shared by the ui-polish Host and browser halves. */

/** One sample of the host process and the machine it runs on. */
export interface ProcessStats {
  /** Host process id. */
  pid: number
  /** Process CPU over the sampling interval, percent of one core (may exceed 100). */
  cpuPercent: number
  /** Resident set size in bytes. */
  rssBytes: number
  /** V8 heap in use, in bytes. */
  heapUsedBytes: number
  /** Process uptime in seconds. */
  uptimeSeconds: number
  /** Machine-level figures read alongside the process sample. */
  system: SystemStats
  /** Sampling instant, Unix epoch ms. */
  sampledAt: number
}

/** Machine-level figures read alongside a process sample. */
export interface SystemStats {
  /** Logical CPU count. */
  cpuCount: number
  /** 1-minute load average. */
  load1: number
  /** 5-minute load average. */
  load5: number
  /** 15-minute load average. */
  load15: number
  /** Total physical memory in bytes. */
  totalMemBytes: number
  /** Free physical memory in bytes. */
  freeMemBytes: number
}
