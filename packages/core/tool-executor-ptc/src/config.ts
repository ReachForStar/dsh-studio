/** Configuration shared by plugin mounting and direct executor construction. @module */
import z from '@deepseek-ai/schemastery'

/** Program execution limits. */
export interface Config {
  /** Nested tool-call attempts per minute of resolved runtime timeout, including failed calls. */
  maxSubCallsPerMinute: number
  /** Maximum overlapping concurrency-safe program subcalls. */
  maxParallelSubCalls: number
  /** Approximate token budget for expanded SDK declarations; tools past it keep a callable binding and move to the one-line catalog. */
  sdkBudgetTokens: number
}

/** Validated timeout-based call allowance, concurrency, and generated-SDK budget. */
export const Config: z<Partial<Config>, Config> = z.object({
  maxSubCallsPerMinute: z.natural().min(1).default(1024),
  maxParallelSubCalls: z.natural().min(1).default(10),
  sdkBudgetTokens: z.natural().default(4000),
})
