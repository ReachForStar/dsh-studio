/** Host registration for the paper library's upload, reading, and annotation routes. */
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the llm Context merge (ctx.llm) for the translator.
import type {} from '@deepseek-ai/dsh-llm'
// Type-only: pulls the webserver Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import Schema from '@deepseek-ai/schemastery'
import { handlePaperRequest } from './paper-service.ts'
import { PAPER_READER_ROUTE, PAPER_TRANSLATE_ROUTE } from './route.ts'
import { createPaperTranslator, handleTranslateRequest } from './translate-service.ts'

/** Default largest accepted upload; larger files are refused before any byte reaches the disk. */
export const MAX_PAPER_BYTES = 100 * 1024 * 1024

/** Default directory holding uploaded papers and their annotation documents. */
export const PAPER_LIBRARY_DIR = dshHomePath('profiles', 'web', 'papers')

/** Deployment choices for the paper library. */
export interface Config {
  /** Directory holding uploaded PDFs and their annotation documents. */
  directory: string
  /** Largest accepted upload in bytes. */
  maxBytes: number
}

/** Validated deployment choices. */
export const Config = Schema.object({
  directory: Schema.string().default(PAPER_LIBRARY_DIR),
  maxBytes: Schema.number().default(MAX_PAPER_BYTES),
})

/**
 * Register the paper library's HTTP surface on the Host webserver, and the
 * translation route once the LLM service is composed.
 * @param ctx - Host context that may acquire the webserver and llm services.
 * @param config - validated library directory and upload bound.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['webServer'], (serverCtx) => {
    serverCtx.effect(() => serverCtx.webServer.register({
      kind: 'prefix',
      path: PAPER_READER_ROUTE,
      handler: (req, res) => handlePaperRequest(config.directory, config.maxBytes, req, res),
    }), 'ui-paper-reader: library route')
  })
  // A separate fiber: the library stays served on a host composed without a model.
  ctx.inject(['webServer', 'llm'], (serverCtx) => {
    const translator = createPaperTranslator(serverCtx)
    serverCtx.effect(() => serverCtx.webServer.register({
      kind: 'prefix',
      path: PAPER_TRANSLATE_ROUTE,
      handler: (req, res) => handleTranslateRequest(translator, req, res),
    }), 'ui-paper-reader: translate route')
  })
}
