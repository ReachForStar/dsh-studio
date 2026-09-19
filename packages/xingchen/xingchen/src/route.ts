/**
 * Star-domain intent routing: the pure heuristic that decides which role a
 * user message targets. Slash commands decide explicitly; keyword signals
 * decide only with two or more distinct hits, so a single weak word never
 * steers a message away from the native router.
 *
 * @module @reachforstar/dsh-xingchen/route
 */

import type { XingchenRoleId, XingchenSpecialistId } from './types.ts'

/** Slash command names that address a specialist role directly. */
export type XingchenCommandName = 'review' | 'bug' | 'planning'

/** The specialist role each slash command addresses. */
export const XINGCHEN_ROLE_COMMANDS: Readonly<Record<XingchenCommandName, XingchenSpecialistId>> = {
  review: 'tianquan',
  bug: 'yaoguang',
  planning: 'tianliang',
}

/** The slash command that addresses each specialist role. */
export const XINGCHEN_COMMAND_ROLES: Readonly<Record<XingchenSpecialistId, XingchenCommandName>> = {
  tianquan: 'review',
  yaoguang: 'bug',
  tianliang: 'planning',
}

/**
 * The specialist role one logged command name addresses.
 *
 * A session log carries whatever command ran, so a consumer of durable events
 * tests the name before reading the map instead of asserting it names a
 * Xingchen command.
 * @param name - the logged command name.
 * @returns the addressed specialist role, or undefined for any other command.
 */
export function roleOfCommand(name: string): XingchenSpecialistId | undefined {
  return Object.hasOwn(XINGCHEN_ROLE_COMMANDS, name)
    ? XINGCHEN_ROLE_COMMANDS[name as XingchenCommandName]
    : undefined
}

/** Display name of each star-domain role. */
export const XINGCHEN_ROLE_NAMES: Readonly<Record<XingchenRoleId, string>> = {
  qiming: '启明',
  tianquan: '天权',
  yaoguang: '瑶光',
  tianliang: '天梁',
}

/** What each specialist role does, for command descriptions and prompts. */
export const XINGCHEN_ROLE_SUMMARIES: Readonly<Record<XingchenSpecialistId, string>> = {
  tianquan: '架构评估与代码审查',
  yaoguang: '疑难 Bug 复现与根因',
  tianliang: '版本规划与分波交付',
}

/**
 * Routing signals per specialist role. CJK keywords match by substring;
 * ASCII keywords match as whole words, case-insensitively.
 */
const ROLE_KEYWORDS: Readonly<Record<XingchenSpecialistId, readonly string[]>> = {
  tianquan: [
    '架构', '审查', '评审', '权衡', '选型', '技术债',
    'architecture', 'code review', 'technical debt', 'design review',
  ],
  yaoguang: [
    '崩溃', '复现', '根因', '报错', '堆栈', '异常', '偶现', '闪退',
    'bug', 'crash', 'reproduce', 'reproduction', 'root cause', 'stack trace', 'segfault', 'flaky',
  ],
  tianliang: [
    '规划', '排期', '拆解', '里程碑', '交付', '波次', '迭代',
    'roadmap', 'milestone', 'sprint', 'backlog', 'breakdown',
  ],
}

/** A leading slash command naming a specialist role. */
const ROLE_COMMAND = /^\/(review|bug|planning)(?=[\t\n\r ]|$)/u

/** Whether one keyword occurs in the lowercased text under its match rule. */
function keywordHit(keyword: string, lower: string): boolean {
  if (/^[\u3400-\u9fff\uf900-\ufaff]/u.test(keyword)) return lower.includes(keyword)
  const word = keyword.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${word}($|[^a-z0-9])`, 'u').test(lower)
}

/**
 * Route one user message to a star-domain role.
 *
 * @param text - the message as submitted.
 * @returns `qiming` when no specialist signal is strong enough; the addressed
 *   specialist only when one role scores strictly higher than every other,
 *   so a message mixing two specialists' signals stays with the native router
 *   to decompose instead of being pulled to whichever role is declared first.
 */
export function routeXingchen(text: string): XingchenRoleId {
  const trimmed = text.trim()
  const command = ROLE_COMMAND.exec(trimmed)
  if (command !== null) return XINGCHEN_ROLE_COMMANDS[command[1] as XingchenCommandName]
  const lower = trimmed.toLowerCase()
  const scores = (Object.entries(ROLE_KEYWORDS) as [XingchenSpecialistId, readonly string[]][])
    .map(([role, keywords]) => ({ role, score: keywords.filter(keyword => keywordHit(keyword, lower)).length }))
  // One weak word never steers a message, and a tie across specialists is the
  // mixed case the router itself is for.
  const top = Math.max(...scores.map(entry => entry.score))
  if (top < 2) return 'qiming'
  const winners = scores.filter(entry => entry.score === top)
  const winner = winners.length === 1 ? winners[0] : undefined
  return winner?.role ?? 'qiming'
}
