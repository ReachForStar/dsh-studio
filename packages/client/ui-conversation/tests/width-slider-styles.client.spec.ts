import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const conversationCss = readFileSync(fileURLToPath(new URL(
  '../src/client/skeleton/ConversationRoot.module.css',
  import.meta.url,
)), 'utf8')

/** Return one stylesheet rule body for an exact class selector. */
function rule(css: string, selector: string): string {
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 's').exec(css)
  expect(match, `missing ${selector} rule`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('conversation width slider styles', () => {
  it('sizes the strip with the axis it controls and keeps it in the flow', () => {
    const slider = rule(conversationCss, '.widthSlider')
    expect(slider).toMatch(/flex:\s*none/)
    expect(slider).toContain('var(--dsh-chat-content-width)')
    expect(slider).toMatch(/margin:\s*8px auto 0/)
  })

  it('hides the strip for views that elect a composer overlay', () => {
    expect(conversationCss).toMatch(
      /\.root:has\(\[data-conversation-composer-overlay\]\)\s*\.widthSlider\s*\{[^}]*display:\s*none/s,
    )
  })

  it('leaves no retired width-handle rules behind', () => {
    expect(conversationCss).not.toContain('.widthHandle')
    expect(conversationCss).not.toContain('data-dragging')
  })
})
