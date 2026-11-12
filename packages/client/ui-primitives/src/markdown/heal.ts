/**
 * Trailing-construct healing for streaming assistant Markdown.
 *
 * A reply arrives in chunks, so a frame can end mid-construct: `**wor`, a
 * half-typed `` `code `` span, or `[label](https://exa`. Rendering that raw
 * tail makes the partial marker flash as literal text (or swallow the rest of
 * the frame) until the closing chunk arrives. This module appends the missing
 * closing delimiter to the accumulated text before it reaches the block
 * parser, so every frame shows the intended construct. Only appends: the
 * healed text stays a prefix extension of the raw text while a construct is
 * open, and drops back when its real closer arrives.
 */

/** One open inline emphasis delimiter run. */
interface OpenEmphasis {
  readonly char: '*' | '_' | '~'
  readonly run: number
  readonly at: number
}

/** Inline state accumulated up to the end of the scanned text. */
interface InlineState {
  /** Backtick run length of the open code span; `0` outside one. */
  codeRun: number
  /** Open emphasis runs, innermost last. */
  emphasis: OpenEmphasis[]
  /** Whether an open link destination follows `](`. */
  destinationOpen: boolean
  /** Whether that destination has any non-space content yet. */
  destinationHasContent: boolean
  /** Position of the last character that is not whitespace. */
  lastContentEnd: number
}

/**
 * Append the closing delimiters of the construct still open at the end of a
 * streaming Markdown text.
 * @param text - The accumulated reply source.
 * @returns `text` unchanged when nothing is open, otherwise the closed text.
 */
export function healStreamingMarkdown(text: string): string {
  if (text.length === 0) return text
  const inFence = fenceMembership(text)
  const state = scanInline(text, inFence)
  if (state.codeRun > 0) return text + '`'.repeat(state.codeRun)
  if (state.destinationOpen && state.destinationHasContent) return `${text})`
  const closers = state.emphasis
    .filter(open => state.lastContentEnd >= open.at + open.run)
    .map(open => (open.char === '~' ? '~~' : open.char.repeat(open.run)))
    .reverse()
    .join('')
  return closers === '' ? text : text + closers
}

/**
 * Mark every character that belongs to a fenced code block.
 * @param text - The accumulated reply source.
 * @returns Membership flags aligned with `text`; fence delimiter lines and
 * bodies are never healed.
 */
function fenceMembership(text: string): boolean[] {
  const inFence = new Array<boolean>(text.length).fill(false)
  const mark = (start: number, end: number): void => {
    for (let at = start; at < end; at += 1) inFence[at] = true
  }
  let fence: { marker: '`' | '~'; length: number } | null = null
  let index = 0
  while (index < text.length) {
    const lineEnd = lineEndAfter(text, index)
    const line = text.slice(index, lineEnd)
    let indent = 0
    while (indent < 3 && line[indent] === ' ') indent += 1
    const marker = line[indent]
    let run = 0
    while (marker !== undefined && line[indent + run] === marker && (marker === '`' || marker === '~')) run += 1
    const closes = fence !== null && marker === fence.marker && run >= fence.length
      && /^[ \t]*$/.test(line.slice(indent + run))
    const opens = fence === null && (marker === '`' || marker === '~') && run >= 3
    if (closes) fence = null
    else if (opens) fence = { marker: marker as '`' | '~', length: run }
    if (closes || opens || fence !== null) mark(index, lineEnd)
    index = lineEnd
    while (index < text.length && (text[index] === '\n' || text[index] === '\r')) index += 1
  }
  return inFence
}

/** Index one past the line terminator ending the line that starts at `start`. */
function lineEndAfter(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '\n') return index
    if (text[index] === '\r') return index
  }
  return text.length
}

/**
 * Walk the non-fence characters and record the inline constructs still open at EOF.
 * @param text - The accumulated reply source.
 * @param inFence - Fence membership flags from {@link fenceAwareLineStarts}.
 * @returns The open-construct state.
 */
function scanInline(text: string, inFence: boolean[]): InlineState {
  const state: InlineState = {
    codeRun: 0,
    emphasis: [],
    destinationOpen: false,
    destinationHasContent: false,
    lastContentEnd: -1,
  }
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (inFence[index]) {
      index += 1
      continue
    }
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '`') {
      let run = 0
      while (text[index + run] === '`') run += 1
      if (state.codeRun === 0) state.codeRun = run
      else if (state.codeRun === run) state.codeRun = 0
      index += run
      continue
    }
    if (state.codeRun > 0) {
      index += 1
      continue
    }
    if (state.destinationOpen) {
      if (char === ')') {
        state.destinationOpen = false
        state.destinationHasContent = false
      } else if (char !== ' ' && char !== '\t') state.destinationHasContent = true
      if (char !== ' ' && char !== '\t') state.lastContentEnd = index
      index += 1
      continue
    }
    if (char === '(' && text[index - 1] === ']') {
      state.destinationOpen = true
      state.destinationHasContent = false
      index += 1
      continue
    }
    if (char === '*' || char === '_' || char === '~') {
      const run = delimiterRun(text, index, char)
      const previous = text.charAt(index - 1)
      const next = text.charAt(index + run)
      const intraword = char === '_' && isWordChar(previous) && isWordChar(next)
      if (intraword) {
        index += run
        continue
      }
      const canClose = previous !== '' && !isSpace(previous)
      const canOpen = next !== ''
      const last = state.emphasis[state.emphasis.length - 1]
      if (canClose && last !== undefined && last.char === char) state.emphasis.pop()
      else if (canOpen) state.emphasis.push({ char, run: Math.min(run, char === '~' ? 2 : 3), at: index })
      index += run
      continue
    }
    if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') state.lastContentEnd = index
    index += 1
  }
  return state
}

/** Length of the delimiter run of `char` starting at `start`. */
function delimiterRun(text: string, start: number, char: string): number {
  let run = 0
  while (text[start + run] === char) run += 1
  return run
}

/** ASCII word character plus non-ASCII letters, for the intraword `_` rule. */
function isWordChar(char: string): boolean {
  return char !== '' && /[\p{L}\p{N}]/u.test(char)
}

/** Whether `char` is Markdown inline whitespace. */
function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r'
}
