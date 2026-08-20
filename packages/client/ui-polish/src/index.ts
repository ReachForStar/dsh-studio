/** Host registration for the ui-polish background-image preference and git panel. */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the webserver Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the workspace registry Context merge (ctx.workspaceRegistry).
import type {} from '@deepseek-ai/dsh-workspace'
import {
  BACKGROUND_SETTINGS_NAMESPACE, MAX_BACKGROUND_IMAGE_BYTES, PolishSettingsSchema,
} from './background-settings.ts'
import { BACKGROUND_IMAGE_FILE, handleBackgroundRequest } from './background-service.ts'
import { installCompactionControl } from './compaction-control.ts'
import { handleExcalidrawRequest } from './excalidraw-service.ts'
import { handleGitRequest, type GitCwdResolver, workspaceCwdResolver } from './git-service.ts'

export {
  BACKGROUND_IMAGE_FIELD, BACKGROUND_SETTINGS_NAMESPACE, MAX_BACKGROUND_IMAGE_BYTES,
  type PolishSettings,
} from './background-settings.ts'
export { handleBackgroundRequest, BACKGROUND_IMAGE_FILE } from './background-service.ts'
export { handleExcalidrawRequest } from './excalidraw-service.ts'
export { handleGitRequest, workspaceCwdResolver, type GitCwdResolver, type GitLogResult, type GitStatusEntry, type GitStatusResult } from './git-service.ts'

const NAMESPACE = settingsNamespace(BACKGROUND_SETTINGS_NAMESPACE)

/** Host process working directory: the fallback repository when no workspace matches. */
const FALLBACK_CWD = process.cwd()

/** Absolute path of the persisted background image (profile dir; survives restarts). */
const BACKGROUND_IMAGE_PATH = dshHomePath('profiles', 'web', BACKGROUND_IMAGE_FILE)

/**
 * Register the durable background section and the git panel HTTP surface when
 * the optional Host settings / webserver services are composed. The git panel
 * targets the workspace the browser is currently viewing: each request carries
 * the workspace path, resolved per request against the live workspace registry
 * so a workspace switch is followed without a restart.
 * @param ctx - Host context that may acquire the settings and webserver services.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(NAMESPACE, PolishSettingsSchema)
    installCompactionControl(settingsCtx, scope)
  })
  ctx.inject(['webServer'], (serverCtx) => {
    const webServer = serverCtx.webServer
    // Resolve per request so a workspace switch is followed without a restart.
    const resolveWorkspaceCwd = (): GitCwdResolver => {
      const workspaceRegistry = serverCtx.get('workspaceRegistry')
      const known = workspaceRegistry === undefined
        ? []
        : workspaceRegistry.list().map(workspace => workspace.path)
      return workspaceCwdResolver(known, FALLBACK_CWD)
    }
    serverCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/git',
      handler: (req, res) => handleGitRequest(resolveWorkspaceCwd(), req, res),
    }), 'ui-polish: git panel route')
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
