/** Host registration for the ui-polish background-image preference and the git/latex panels. */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the webserver Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the workspace registry Context merge (ctx.workspaceRegistry).
import type {} from '@deepseek-ai/dsh-workspace'
// Type-only: pulls the settings Context merge (ctx.settings).
import type {} from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Git commit-message and LaTeX writing requests this package issues on the
     * user's behalf. Readers preserve the message without the producer, and
     * the kind imposes no validation, replay, or authority requirement.
     * @persistenceAttribution
     */
    'ui-polish': { kind: 'ui-polish' }
  }
}

import { MAX_BACKGROUND_IMAGE_BYTES } from './background-settings.ts'
import type { Config } from './background-settings.ts'
import { BACKGROUND_IMAGE_FILE, handleBackgroundRequest } from './background-service.ts'
import { installCompactionControl } from './compaction-control.ts'
import { handleExcalidrawRequest } from './excalidraw-service.ts'
import { handleGitRequest, type GitCwdResolver, workspaceCwdResolver } from './git-service.ts'
import { createCommitMessageBridge } from './git-llm.ts'
import { handleLatexRequest } from './latex-service.ts'

export {
  BACKGROUND_IMAGE_FIELD, BACKGROUND_SETTINGS_NAMESPACE, Config, MAX_BACKGROUND_IMAGE_BYTES,
  type PolishSettings,
} from './background-settings.ts'
export { handleBackgroundRequest, BACKGROUND_IMAGE_FILE } from './background-service.ts'
export { handleExcalidrawRequest } from './excalidraw-service.ts'
export {
  handleGitRequest, workspaceCwdResolver, type CommitMessageBridge,
  type GitBranchesResult, type GitCwdResolver, type GitCommit, type GitFile, type GitStatusResult,
} from './git-service.ts'
export { handleLatexRequest } from './latex-service.ts'

/** Host process working directory: the fallback repository when no workspace matches. */
const FALLBACK_CWD = process.cwd()

/** Absolute path of the persisted background image (profile dir; survives restarts). */
const BACKGROUND_IMAGE_PATH = dshHomePath('profiles', 'web', BACKGROUND_IMAGE_FILE)

/**
 * Register the git/latex/background HTTP surfaces and the configurable
 * automatic-compaction control. The ui-polish preferences live on this entry's
 * volatile Config; the plugin withdraws its fiber from the generated settings
 * pages because it ships custom rows instead. The git panel targets the
 * workspace the browser is currently viewing: each request carries the
 * workspace path, resolved per request against the live workspace registry so a
 * workspace switch is followed without a restart.
 * @param ctx - Host context that may acquire the settings and webserver services.
 * @param config - this entry's live volatile Config.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })
  installCompactionControl(ctx, config)
  ctx.inject(['webServer', 'llm'], (serverCtx) => {
    const webServer = serverCtx.webServer
    // Resolve per request so a workspace switch is followed without a restart.
    const resolveWorkspaceCwd = (): GitCwdResolver => {
      const workspaceRegistry = serverCtx.get('workspaceRegistry')
      const known = workspaceRegistry === undefined
        ? []
        : workspaceRegistry.list().map(workspace => workspace.path)
      return workspaceCwdResolver(known, FALLBACK_CWD)
    }
    const commitMessageBridge = createCommitMessageBridge(serverCtx)
    serverCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/git',
      handler: (req, res) => handleGitRequest(resolveWorkspaceCwd(), req, res, commitMessageBridge),
    }), 'ui-polish: git panel route')
    // LaTeX: projects, files, compilation (local TeX), PDF preview, fonts, AI writing.
    serverCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/latex',
      handler: (req, res) => handleLatexRequest(resolveWorkspaceCwd(), serverCtx, req, res),
    }), 'ui-polish: latex panel route')
    // Background image: persisted as a file, served at /bg/current.
    serverCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/bg',
      handler: (req, res) => handleBackgroundRequest(BACKGROUND_IMAGE_PATH, MAX_BACKGROUND_IMAGE_BYTES, req, res),
    }), 'ui-polish: background image route')
    // Excalidraw: persist workspace scenes for the embedded whiteboard.
    serverCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/scene',
      handler: (req, res) => handleExcalidrawRequest(resolveWorkspaceCwd(), req, res),
    }), 'ui-polish: excalidraw scene route')
  })
}
