/**
 * Pure approval-rule evaluation: `{action, resource, effect}` entries with
 * `*`/`?` wildcards, evaluated last match wins so a deployment can append a
 * narrow exception after a broad rule. A request carries one action and zero
 * or more resource names; an empty resource list matches only a `*` rule and
 * therefore pairs naturally with action-only rules.
 * @module @deepseek-ai/dsh-user-approval/rules
 */

/** What a matching rule decides before any answerer is consulted. */
export type ApprovalRuleEffect = 'allow' | 'deny' | 'ask'

/** One ordered approval rule; later matches override earlier ones. */
export interface ApprovalRule {
  /** Action pattern, matched against the tool's declared action or its tool name. */
  readonly action: string
  /** Resource pattern, matched against every declared resource name. */
  readonly resource: string
  /** Decision for a matching request. */
  readonly effect: ApprovalRuleEffect
}

/** The classified subject of one approval request. */
export interface ApprovalRuleRequest {
  /** Action name from the tool classification, or the tool name. */
  readonly action: string
  /** Resource names from the tool classification; empty for tool-wide rules. */
  readonly resources: readonly string[]
}

/**
 * Match one `*`/`?` pattern against a value. `*` matches any run of characters
 * (including separators) and `?` exactly one.
 * @param pattern - the rule pattern.
 * @param value - the action or resource name to test.
 * @returns whether the whole value matches.
 */
export function matchApprovalPattern(pattern: string, value: string): boolean {
  let source = '^'
  for (const character of pattern) {
    if (character === '*') {
      source += '.*'
      continue
    }
    if (character === '?') {
      source += '.'
      continue
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  }
  return new RegExp(`${source}$`, 'u').test(value)
}

/**
 * Evaluate rules for one request. A rule matches when its action pattern
 * matches and, for a request with resources, at least one resource matches its
 * resource pattern; a request without resources matches only `*` resources.
 * The last matching rule wins.
 * @param rules - ordered rules from deployment configuration.
 * @param request - the classified action and resources.
 * @returns the deciding effect, or `undefined` when no rule matched.
 */
export function evaluateApprovalRules(
  rules: readonly ApprovalRule[],
  request: ApprovalRuleRequest,
): ApprovalRuleEffect | undefined {
  let effect: ApprovalRuleEffect | undefined
  for (const rule of rules) {
    if (!matchApprovalPattern(rule.action, request.action)) continue
    const matches = request.resources.length === 0
      ? rule.resource === '*'
      : request.resources.some(resource => matchApprovalPattern(rule.resource, resource))
    if (matches) effect = rule.effect
  }
  return effect
}
