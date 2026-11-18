/**
 * `/checkpoint` 命令：为当前会话的工作目录创建 Git 检查点并恢复。
 *
 * 检查点用 `git stash create` 生成一个 stash 提交引用，命令把最近一次引用
 * 存在进程内存中；`/checkpoint restore` 用 `git stash apply` 恢复。检查点
 * 只服务当前进程，进程重启后引用丢失，但 stash 仍在仓库中，可用
 * `git stash list` 查看。
 *
 * @module @deepseek-ai/dsh-git-checkpoint
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-shell'

declare module '@deepseek-ai/cordis' {
  interface Context {
    gitCheckpoints: GitCheckpointService
  }
}

/** 配置。 */
export interface Config {
  /** 单条 git 命令的截止时间（毫秒）。 */
  timeoutMs: number
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().step(1).min(1).default(10_000),
})

/** 一条 git 命令的结果。 */
interface GitRun {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Git 检查点服务（`ctx.gitCheckpoints`）：在工作目录执行 git 并保存最近引用。
 */
export class GitCheckpointService extends Service {
  /** 服务名。 */
  static provide = 'gitCheckpoints'
  static inject = ['shell']

  private readonly last = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'gitCheckpoints')
  }

  /**
   * 读取一个会话最近一次的检查点引用。
   * @param session - 会话。
   * @returns stash 引用；无检查点时 undefined。
   */
  lastOf(session: Session): string | undefined {
    return this.last.get(session.id)
  }

  /**
   * 清除一个会话保存的检查点引用。
   * @param session - 会话。
   */
  clear(session: Session): void {
    this.last.delete(session.id)
  }

  /**
   * 为会话工作目录创建检查点。
   * @param session - 会话。
   * @param timeoutMs - 单条命令截止时间。
   * @returns stash 引用；工作区无改动时 undefined。
   */
  async capture(session: Session, timeoutMs: number): Promise<string | undefined> {
    await this.insideWorkTree(session, timeoutMs)
    const run = await this.run(session, ['stash', 'create'], timeoutMs)
    if (run.exitCode !== 0) {
      throw new Error(`git stash create failed: ${run.stderr.trim() || `exit ${String(run.exitCode)}`}`)
    }
    const ref = run.stdout.trim()
    if (ref.length === 0) return undefined
    this.last.set(session.id, ref)
    return ref
  }

  /**
   * 把一个检查点引用恢复到会话工作目录。
   * @param session - 会话。
   * @param ref - stash 引用。
   * @param timeoutMs - 单条命令截止时间。
   */
  async restore(session: Session, ref: string, timeoutMs: number): Promise<void> {
    await this.insideWorkTree(session, timeoutMs)
    const run = await this.run(session, ['stash', 'apply', ref], timeoutMs)
    if (run.exitCode !== 0) {
      throw new Error(`git stash apply failed: ${run.stderr.trim() || `exit ${String(run.exitCode)}`}`)
    }
  }

  /** 确认工作目录位于 Git 仓库内。 */
  private async insideWorkTree(session: Session, timeoutMs: number): Promise<void> {
    const run = await this.run(session, ['rev-parse', '--is-inside-work-tree'], timeoutMs)
    if (run.exitCode !== 0 || run.stdout.trim() !== 'true') {
      throw new Error('git checkpoint requires the session working directory to be inside a Git work tree')
    }
  }

  /** 在会话工作目录执行一条 git 命令。 */
  private async run(session: Session, args: readonly string[], timeoutMs: number): Promise<GitRun> {
    const workdir = session.header.cwd
    if (workdir === undefined) throw new Error('git checkpoint requires a session working directory')
    const spec = this.ctx.shell.resolve({ command: ['git', ...args].join(' '), workdir, timeoutMs })
    const handle = await this.ctx.shell.execute(spec)
    const result = await handle.result()
    return { exitCode: result.exitCode, stdout: result.stdout.text, stderr: result.stderr.text }
  }
}

/**
 * 执行 `/checkpoint`：无参数捕获，`restore` 恢复，`clear` 清除引用。
 * @param service - 检查点服务。
 * @param invocation - 命令调用。
 * @param config - 生效配置。
 * @returns 命令结果。
 */
export function executeCheckpoint(
  service: GitCheckpointService,
  invocation: CommandInvocation,
  config: Config,
): Promise<CommandResult> {
  const input = invocation.rawInput.trim().toLowerCase()
  const session = invocation.agent.session
  if (input === 'clear') {
    service.clear(session)
    return Promise.resolve({ kind: 'success', text: 'Checkpoint cleared.' })
  }
  if (input === 'restore') {
    const ref = service.lastOf(session)
    if (ref === undefined) return Promise.resolve({ kind: 'error', text: 'No checkpoint to restore.' })
    return service.restore(session, ref, config.timeoutMs).then(
      () => ({ kind: 'success', text: `Restored checkpoint ${ref.slice(0, 12)}.` }),
      (error: unknown) => ({ kind: 'error', text: String(error) }),
    )
  }
  if (input.length > 0) return Promise.resolve({ kind: 'error', text: 'Usage: /checkpoint [restore|clear]' })
  return service.capture(session, config.timeoutMs).then(
    ref => ({ kind: 'success', text: ref === undefined ? 'No changes to checkpoint.' : `Checkpoint ${ref.slice(0, 12)} created.` }),
    (error: unknown) => ({ kind: 'error', text: String(error) }),
  )
}

export const name = 'git-checkpoint'

export const inject = ['commands', 'shell']

/** 注册 `/checkpoint` 命令。 */
export function apply(ctx: Context, config: Config): void {
  const service = new GitCheckpointService(ctx)
  ctx.provide('gitCheckpoints', service)
  ctx.commands.register({
    name: 'checkpoint',
    description: 'Create or restore a Git checkpoint of the working directory',
    input: { hint: '[restore|clear]' },
    handler: invocation => executeCheckpoint(service, invocation, config),
  })
}
