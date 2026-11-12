/** The node half stays inert: this package renders fences only in the browser. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('ui-markdown-mermaid node plugin', () => {
  it('mounts without registering a host service', async () => {
    ctx = new Context()
    await ctx.plugin({ apply }).await()
    expect(ctx.get('tools')).toBeUndefined()
  })
})
