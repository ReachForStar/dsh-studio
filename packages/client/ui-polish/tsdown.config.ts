import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientBundle } from '../tsdown.client.ts'

// 浏览器端 node:crypto shim 的物理路径。Excalidraw 依赖树内的 nanoid（3.x CJS
// 与 4.x node 版）与 uuid@14 node 版在模块顶层引用 "crypto"/"node:crypto" 与
// 全局 Buffer；browser 平台构建会把 node builtin 保留为 external require，
// 而 client module table 没有 crypto 词条，加载即抛 require miss。这里把两个
// specifier 直接内联为 crypto-shim（named + default 导出，含 Buffer 兜底副作用）。
const CRYPTO_SHIM = resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/client/crypto-shim.ts')

/**
 * ui-polish builds: the node-half lib plus the browser client bundle. The
 * Excalidraw whiteboard is embedded directly into the client bundle (the
 * canvas tab renders <Excalidraw> in-document, no iframe), so react/react-dom
 * come from the platform module table while Excalidraw is inlined.
 */
export default clientBundle('@deepseek-ai/dsh-client-ui-polish', ['lib/types/index.js', 'lib/types/invariant.js'], {
  clientPlugins: [{
    name: 'dsh-crypto-shim',
    resolveId(source: string) {
      if (source === 'crypto' || source === 'node:crypto') return CRYPTO_SHIM
      return null
    },
  }],
})
