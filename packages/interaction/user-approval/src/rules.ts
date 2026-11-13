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

/** How a rule's resource field matches a declared resource name. */
export type ApprovalRuleMatch = 'glob' | 'prefix'

/** One ordered approval rule; later matches override earlier ones. */
export interface ApprovalRule {
  /** Action pattern, matched against the tool's declared action or its tool name. */
  readonly action: string
  /**
   * Resource pattern for `glob` rules, or the literal command prefix for
   * `prefix` rules. A prefix matches whole command words only, so `git status`
   * never grants `git statuspage` or a second command joined by `&&`.
   */
  readonly resource: string
  /** Decision for a matching request. */
  readonly effect: ApprovalRuleEffect
  /** Resource matching mode. */
  readonly match: ApprovalRuleMatch
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
 * Split one command line into literal words for conservative prefix matching.
 * Quoting and backslash escapes are honored. Any shell construct whose effect
 * is not visible in the words themselves — control operators, redirection,
 * command substitution, subshells, comments, and expansion inside double
 * quotes — makes the command ineligible, so a prefix rule can only match
 * commands it fully understands.
 * @param command - the command line to split.
 * @returns literal words, or `undefined` for unsupported syntax.
 */
export function splitCommandWords(command: string): readonly string[] | undefined {
  const words: string[] = []
  let word = ''
  let started = false
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index)
    if (quote === "'") {
      if (character === "'") quote = undefined
      else word += character
      continue
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined
        continue
      }
      if (character === '\\' && index + 1 < command.length) {
        const escaped = command.charAt(index + 1)
        // Inside double quotes a backslash only escapes these characters; keep
        // the pair verbatim for any other character instead of guessing.
        if (escaped === '"' || escaped === '\\' || escaped === '$' || escaped === '`') {
          word += escaped
          index += 1
          continue
        }
        word += character
        continue
      }
      if (character === '$' || character === '`') return undefined
      word += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      started = true
      continue
    }
    if (character === '\\') {
      if (index + 1 >= command.length) return undefined
      word += command.charAt(index + 1)
      index += 1
      started = true
      continue
    }
    if (character === ' ' || character === '\t') {
      if (started) {
        words.push(word)
        word = ''
        started = false
      }
      continue
    }
    if (character === '\n' || character === '\r' || character === ';' || character === '&'
      || character === '|' || character === '<' || character === '>' || character === '('
      || character === ')' || character === '`' || character === '{' || character === '}') {
      return undefined
    }
    if (character === '$' && command[index + 1] === '(') return undefined
    word += character
    started = true
  }
  if (quote !== undefined) return undefined
  if (started) words.push(word)
  return words
}

/**
 * Match a literal command prefix against a command line. The command must be
 * one supported segment whose leading words equal the prefix; a prefix rule
 * therefore grants `git status -s` but not `git push` or `git status && rm -rf`.
 * @param prefix - literal command words, for example `git status`.
 * @param command - the declared shell command.
 * @returns whether the command starts with exactly those words.
 */
export function matchCommandPrefix(prefix: string, command: string): boolean {
  const expected = splitCommandWords(prefix)
  const actual = splitCommandWords(command)
  if (expected === undefined || actual === undefined || expected.length === 0) return false
  return expected.length <= actual.length && expected.every((word, index) => actual[index] === word)
}

/**
 * Derive the conservative prefix a command may be granted under: its first
 * word plus the second when that word is an argument rather than an option.
 * @param command - the command line to inspect.
 * @returns the prefix, or `undefined` for unsupported syntax.
 */
export function commandPrefixOf(command: string): string | undefined {
  const words = splitCommandWords(command)
  if (words === undefined || words.length === 0) return undefined
  const first = words[0]
  if (first === undefined) return undefined
  const second = words[1]
  return second === undefined || second.startsWith('-') ? first : `${first} ${second}`
}

/**
 * Match one value against a rule's resource field in that rule's mode.
 * @param rule - the rule supplying the pattern and mode.
 * @param value - the declared resource name.
 * @returns whether the resource matches.
 */
function matchesResource(rule: ApprovalRule, value: string): boolean {
  return rule.match === 'prefix' ? matchCommandPrefix(rule.resource, value) : matchApprovalPattern(rule.resource, value)
}

/**
 * Evaluate rules for one request. A rule matches when its action pattern
 * matches and, for a request with resources, at least one resource matches its
 * resource field; a request without resources matches only `*` resources.
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
      : request.resources.some(resource => matchesResource(rule, resource))
    if (matches) effect = rule.effect
  }
  return effect
}
