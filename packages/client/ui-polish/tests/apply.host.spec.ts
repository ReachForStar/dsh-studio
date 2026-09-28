/** ui-polish node half: withdraws its fiber from the generated settings pages. */
import { describe, it } from 'vitest'
import { omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import * as polish from '../src/index.ts'

describe('ui-polish host', () => {
  // The preferences live on this entry's volatile Config and the browser half
  // ships custom rows, so the host half keeps the fiber off the auto-generated
  // settings pages instead of registering a namespace.
  it('withdraws its fiber from the generated settings pages', async () => {
    await omitsGeneratedPage(ctx => ctx.plugin(polish))
  })
})
