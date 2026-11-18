/**
 * codemode：在受限沙箱中执行模型编写的 JavaScript，唯一能力是调用注入的工具与非 LLM 模型。
 *
 * 沙箱用 Node 内置 `node:vm`，没有网络、文件系统与定时器；脚本只能经 `tools` 与
 * `models` 触及外部。脚本作为 async 函数体运行，支持顶层 `await` 与 `return`。
 *
 * @module @deepseek-ai/dsh-codemode
 */

import vm from 'node:vm'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallBlock, ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'

/** 配置。 */
export interface Config {
  /** 脚本同步执行的截止时间（毫秒）；异步工具调用不受此限制。 */
  timeoutMs: number
  /** 脚本输出的字符上限。 */
  maxOutputChars: number
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().step(1).min(1).default(30_000),
  maxOutputChars: z.number().step(1).min(1).default(16_000),
})

/** codemode 服务：运行脚本并暴露沙箱全局。 */
export class CodemodeService {
  private readonly store = new Map<string, unknown>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /**
   * 运行一段脚本。
   * @param agent - 调用脚本的代理，决定可调用工具。
   * @param source - 脚本文本。
   * @param signal - 取消信号。
   * @returns 脚本输出文本。
   */
  async run(agent: Agent | undefined, source: string, signal: AbortSignal): Promise<string> {
    const output: string[] = []
    const text = (value: unknown): void => {
      output.push(typeof value === 'string' ? value : JSON.stringify(value))
    }
    const definitions = agent === undefined ? [] : this.ctx.tools.definitions(agent)
    const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
    for (const definition of definitions) {
      const key = definition.name.replace(/[^a-zA-Z0-9_]/gu, '_')
      tools[key] = (args: unknown) => this.callTool(agent, definition.name, args, signal)
    }
    const models = {
      classify: (request: unknown) => this.ctx.llm.classify(request as never),
      generateImages: (request: unknown) => this.ctx.llm.generateImages(request as never),
    }
    const store = (key: string, value: unknown): void => {
      if (value === undefined) this.store.delete(key)
      else this.store.set(key, value)
    }
    const load = (key: string): unknown => this.store.get(key)
    const exit = (): void => {
      throw new CodemodeExit()
    }
    const sandbox = { tools, models, text, store, load, exit, console, return: text }
    const context = vm.createContext(sandbox)
    const script = new vm.Script(`(async () => {\n${source}\n})()`, { filename: 'codemode.js' })
    try {
      const returned: unknown = await script.runInContext(context, { timeout: this.config.timeoutMs })
      if (returned !== undefined) text(returned)
    } catch (error: unknown) {
      if (error instanceof CodemodeExit) return this.render(output, undefined)
      return this.render(output, error)
    }
    return this.render(output, undefined)
  }

  /** 经工具运行时调用一个工具并取回文本内容。 */
  private async callTool(agent: Agent | undefined, name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    if (agent === undefined) throw new Error('codemode: no agent is active')
    const call: ToolCallBlock = {
      type: 'tool-call',
      id: brandString<ToolCallId>(`codemode-${String(this.store.size)}-${name}`),
      name,
      arguments: JSON.stringify(args),
    }
    const result = await this.ctx.tools.execute({ agent, calls: [call], signal })
    const content: readonly ContentBlock[] = result.results[0]?.result.content ?? []
    return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  }

  /** 组装输出；超限时保留首尾并给出省略标记。 */
  private render(output: readonly string[], error: unknown): string {
    const joined = output.join('\n')
    const body = joined.length > this.config.maxOutputChars
      ? `${joined.slice(0, this.config.maxOutputChars / 2)}\n...[truncated]...\n${joined.slice(-this.config.maxOutputChars / 2)}`
      : joined
    const prefix = error === undefined ? 'Script completed' : 'Script failed'
    const suffix = error === undefined ? '' : `\nScript error: ${errorMessage(error)}`
    return `${prefix}\n${body}${suffix}`
  }
}

/** 读取一个脚本错误的文本，兼容跨 vm 上下文的 Error。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message)
  return JSON.stringify(error)
}

/** 脚本调用 `exit()` 时抛出的内部信号。 */
class CodemodeExit extends Error {}

/** 创建 `run_code` 工具定义。 */
export function createCodemodeTool(service: CodemodeService): ToolDefinition {
  return defineTool({
    name: 'run_code',
    description: 'Run a JavaScript script in a sandbox. The script can call injected tools and non-LLM models through `tools` and `models`; only its output reaches the model.',
    parameters: {
      script: { type: 'string', description: 'JavaScript source, run as an async function body; top-level await and return are allowed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { output: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.output }],
    },
    execute(args, exec) {
      return service.run(exec.agent, args.script ?? '', exec.signal).then(output => ({ output }))
    },
  })
}

export const name = 'codemode'

export const inject = ['llm', 'tools']

/** 注册 `run_code` 工具。 */
export function apply(ctx: Context, config: Config): void {
  const service = new CodemodeService(ctx, config)
  ctx.tools.register(createCodemodeTool(service))
}
