/**
 * 提示模板：把 Markdown 模板文件变成 `/名字` 命令，展开后作为用户消息进入模型。
 *
 * 模板与命令并列：用户输入 `/review 目标` 时，模板正文替换参数后成为一条用户
 * 消息，与普通输入走同一会话路径。模板命令自身不产生模型消息，只把展开结果
 * 注入会话；模板名与既有命令冲突时跳过并告警。
 *
 * @module @deepseek-ai/dsh-prompt-templates
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parse as parseYaml } from 'yaml'
import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 提示模板展开后注入的用户消息。 */
    'prompt-template': { kind: 'prompt-template'; template: string }
  }
}

/** 一个已加载的提示模板。 */
export interface PromptTemplate {
  /** 命令名，取自文件名。 */
  readonly name: string
  /** frontmatter 的描述，用于命令发现。 */
  readonly description: string
  /** frontmatter 的参数提示，用于输入框。 */
  readonly argumentHint?: string
  /** frontmatter 之后的正文，含参数占位符。 */
  readonly body: string
}

/** 配置。 */
export interface Config {
  /** 扫描模板的目录；直接子文件中的 `.md` 会被加载。 */
  directories: string[]
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  directories: z.array(z.string()).default([]),
})

/**
 * 解析 shell 风格参数：引号只在参数开头生效，引号内反斜杠转义同种引号。
 * @param input - 原始输入。
 * @returns 参数列表。
 */
export function parseArguments(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: string | undefined
  let started = false
  let index = 0
  while (index < input.length) {
    const char = input[index] ?? ''
    if (quote !== undefined) {
      if (char === '\\' && input[index + 1] === quote) {
        current += quote
        index += 2
        continue
      }
      if (char === quote) {
        quote = undefined
        index += 1
        continue
      }
      current += char
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      if (!started) {
        quote = char
        started = true
        index += 1
        continue
      }
      current += char
      started = true
      index += 1
      continue
    }
    if (/\s/u.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
      index += 1
      continue
    }
    current += char
    started = true
    index += 1
  }
  if (started) args.push(current)
  return args
}

/**
 * 把参数代入模板正文；支持 `$1`、`$@`、`$ARGUMENTS` 与 `${...}` 形式。
 * @param body - 模板正文。
 * @param args - 参数。
 * @returns 展开后的文本。
 */
export function expandTemplate(body: string, args: readonly string[]): string {
  const all = () => args.join(' ')
  const positional = (index: number): string => (index >= 1 && index <= args.length ? args[index - 1] ?? '' : '')
  const slice = (raw: string) => {
    const [startText, lengthText] = raw.split(':')
    const start = Number(startText)
    if (!Number.isInteger(start) || start < 1) return ''
    const offset = start - 1
    return lengthText === undefined
      ? args.slice(offset).join(' ')
      : args.slice(offset, offset + Number(lengthText)).join(' ')
  }
  const braced = (content: string): string => {
    const fallbackSplit = content.split(':-')
    if (fallbackSplit.length === 2) {
      const head = fallbackSplit[0] ?? ''
      const fallback = fallbackSplit[1] ?? ''
      if (head === '@') return args.length > 0 ? all() : fallback
      if (/^[1-9]$/u.test(head)) return positional(Number(head)) || fallback
      return ''
    }
    if (content === '@') return all()
    if (content.startsWith('@:')) return slice(content.slice(2))
    if (/^[1-9]$/u.test(content)) return positional(Number(content))
    return ''
  }
  const substitute = (_match: string, bracedContent: string | undefined, positionalDigit: string | undefined): string => {
    if (bracedContent !== undefined) return braced(bracedContent)
    if (positionalDigit !== undefined) return positional(Number(positionalDigit))
    return all()
  }
  return body.replace(/\$\{([^}]*)\}|\$@|\$ARGUMENTS|\$([1-9])/gu, substitute)
}

/**
 * 解析一个模板文件；缺少描述或正文为空时返回 undefined。
 * @param name - 命令名。
 * @param raw - 文件原文。
 * @returns 模板；无效时 undefined。
 */
export function parseTemplate(name: string, raw: string): PromptTemplate | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (match === null) return undefined
  const data = parseYaml(match[1] ?? '') as Record<string, unknown> | null
  const description = typeof data?.description === 'string' ? data.description : ''
  if (description.length === 0) return undefined
  const body = (match[2] ?? '').trim()
  if (body.length === 0) return undefined
  const argumentHint = typeof data?.['argument-hint'] === 'string' ? data['argument-hint'] : undefined
  return { name, description, ...argumentHint === undefined ? {} : { argumentHint }, body }
}

/**
 * 展开一条输入：匹配 `/名字 参数` 时返回展开文本，否则 undefined。
 * @param templates - 模板映射。
 * @param input - 用户输入。
 * @returns 展开文本；不匹配时 undefined。
 */
export function expandInput(templates: ReadonlyMap<string, PromptTemplate>, input: string): string | undefined {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/')) return undefined
  const withoutSlash = trimmed.slice(1)
  const space = withoutSlash.search(/\s/u)
  const name = space === -1 ? withoutSlash : withoutSlash.slice(0, space)
  const template = templates.get(name.toLowerCase())
  if (template === undefined) return undefined
  const rest = space === -1 ? '' : withoutSlash.slice(space)
  return expandTemplate(template.body, parseArguments(rest))
}

/**
 * 从目录加载模板；非 `.md` 文件与解析失败的文件被忽略。
 * @param directories - 模板目录。
 * @returns 命令名到模板的映射。
 */
export async function loadTemplates(directories: readonly string[]): Promise<Map<string, PromptTemplate>> {
  const templates = new Map<string, PromptTemplate>()
  for (const directory of directories) {
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (extname(entry) !== '.md') continue
      const name = basename(entry, '.md').toLowerCase()
      if (name.length === 0 || templates.has(name)) continue
      try {
        const raw = await readFile(join(directory, entry), 'utf8')
        const template = parseTemplate(name, raw)
        if (template !== undefined) templates.set(name, template)
      } catch {
        // 单个不可读文件不影响其余模板。
      }
    }
  }
  return templates
}

/**
 * 执行模板命令：展开结果作为用户消息注入，命令自身不产生模型消息。
 * @param invocation - 命令调用。
 * @param template - 命中的模板。
 * @returns 命令结果。
 */
export function executeTemplate(
  invocation: CommandInvocation,
  template: PromptTemplate,
): CommandResult {
  const text = expandTemplate(template.body, parseArguments(invocation.rawInput))
  const message: Message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'prompt-template', template: template.name },
  })
  invocation.agent.followup(message)
  return { kind: 'success', text: `Template "${template.name}" expanded into your message.` }
}

export const name = 'prompt-templates'

export const inject = ['commands']

/** 加载目录中的模板并为每个模板注册展开命令。 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const templates = await loadTemplates(config.directories)
  for (const template of templates.values()) {
    if (!/^[a-z0-9_-]+$/u.test(template.name)) {
      ctx.logger.warn(`prompt-templates: template name "${template.name}" is not a valid command name; skipped`)
      continue
    }
    try {
      ctx.commands.register({
        name: template.name,
        description: template.description,
        ...template.argumentHint === undefined ? {} : { input: { hint: template.argumentHint } },
        handler: invocation => executeTemplate(invocation, template),
      })
    } catch (error: unknown) {
      ctx.logger.warn(`prompt-templates: template "${template.name}" was not registered: ${String(error)}`)
    }
  }
}
