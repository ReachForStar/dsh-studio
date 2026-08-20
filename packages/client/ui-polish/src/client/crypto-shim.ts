/**
 * 浏览器端 node:crypto 最小 shim。Excalidraw 依赖树内的 nanoid（3.x CJS 与 4.x
 * node 版构建）在模块顶层引用 "crypto" 的 `randomFillSync`，uuid@14 的 node 版
 * 引用 `createHash`（md5/sha1）与全局 `Buffer`；浏览器都没有这些 API。这里用
 * Web Crypto 与纯 JS 摘要实现等价物，顶层副作用同时兜底 `Buffer` 全局（其随机
 * 池/字节随即被 randomFillSync 覆盖写满，返回普通 Uint8Array 即可）。
 */

/** 用 Web Crypto 随机字节填满缓冲（node:crypto.randomFillSync 的浏览器等价物）。
 * @param buffer - 待填满的字节缓冲。
 * @returns 同一缓冲（已填满随机字节）。
 */
export function randomFillSync(buffer: Uint8Array): Uint8Array {
  crypto.getRandomValues(buffer as Uint8Array<ArrayBuffer>)
  return buffer
}

/** 生成指定字节数的随机字节（node:crypto.randomBytes 的浏览器等价物）。
 * @param size - 字节数。
 * @returns 随机字节缓冲。
 */
export function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size)
  crypto.getRandomValues(out)
  return out
}

/** 生成随机 UUID v4（node:crypto.randomUUID 的浏览器等价物）。
 * @returns UUID v4 字符串。
 */
export function randomUUID(): string {
  return crypto.randomUUID()
}

/** Web Crypto 对象本体。 */
export const webcrypto: Crypto = crypto

/** 填充任意 ArrayBufferView（node:crypto.getRandomValues 的浏览器等价物）。
 * @param array - 待填充的 ArrayBufferView。
 * @returns 同一视图（已填充随机字节）。
 */
export function getRandomValues<T extends ArrayBufferView<ArrayBuffer>>(array: T): T {
  return crypto.getRandomValues(array)
}

/** 左旋 32 位整数。 */
function rotateLeft(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0
}

/** MD5 正弦表：T[i] = floor(2^32 * |sin(i+1)|)。 */
const MD5_TABLE = new Uint32Array(64)
for (let i = 0; i < 64; i++) {
  MD5_TABLE[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000)
}

/** MD5 每步左旋位数（按轮分组）。 */
const MD5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

/** 同步 MD5（RFC 1321）。@returns 16 字节小端摘要。 */
function md5Digest(input: Uint8Array): Uint8Array {
  const bitLenLow = (input.length * 8) >>> 0
  const bitLenHigh = Math.floor(input.length / 0x20000000)
  const padded = new Uint8Array((Math.floor((input.length + 8) / 64) + 1) * 64)
  padded.set(input)
  padded[input.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, bitLenLow, true)
  view.setUint32(padded.length - 4, bitLenHigh, true)

  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476
  const x = new Uint32Array(16)
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) x[i] = view.getUint32(block + i * 4, true)
    let aa = a
    let bb = b
    let cc = c
    let dd = d
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (bb & cc) | (~bb & dd)
        g = i
      } else if (i < 32) {
        f = (dd & bb) | (~dd & cc)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = bb ^ cc ^ dd
        g = (3 * i + 5) % 16
      } else {
        f = cc ^ (bb | ~dd)
        g = (7 * i) % 16
      }
      const nextB = (bb + rotateLeft((aa + f + (x[g] ?? 0) + (MD5_TABLE[i] ?? 0)) >>> 0, (MD5_SHIFT[i] ?? 0))) >>> 0
      aa = dd
      dd = cc
      cc = bb
      bb = nextB
    }
    a = (a + aa) >>> 0
    b = (b + bb) >>> 0
    c = (c + cc) >>> 0
    d = (d + dd) >>> 0
  }
  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, a, true)
  outView.setUint32(4, b, true)
  outView.setUint32(8, c, true)
  outView.setUint32(12, d, true)
  return out
}

/** 同步 SHA-1（FIPS 180-1）。@returns 20 字节大端摘要。 */
function sha1Digest(input: Uint8Array): Uint8Array {
  const bitLen = BigInt(input.length) * 8n
  const padded = new Uint8Array((Math.floor((input.length + 8) / 64) + 1) * 64)
  padded.set(input)
  padded[input.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setBigUint64(padded.length - 8, bitLen, false)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4, false)
    for (let i = 16; i < 80; i++) {
      w[i] = rotateLeft((w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0), 1)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (rotateLeft(a, 5) + f + e + k + (w[i] ?? 0)) >>> 0
      e = d
      d = c
      c = rotateLeft(b, 30)
      b = a
      a = temp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  const out = new Uint8Array(20)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, h0, false)
  outView.setUint32(4, h1, false)
  outView.setUint32(8, h2, false)
  outView.setUint32(12, h3, false)
  outView.setUint32(16, h4, false)
  return out
}

/** node:crypto.createHash 的同步浏览器等价物（支持 md5 与 sha1）。
 * @param algorithm - 摘要算法名（md5 或 sha1）。
 * @returns 链式 update 后经 digest 产出摘要的句柄。
 */
export function createHash(algorithm: 'md5' | 'sha1'): {
  update(data: Uint8Array | string): unknown
  digest(): Uint8Array
} {
  const chunks: Uint8Array[] = []
  let totalLength = 0
  return {
    update(data: Uint8Array | string): unknown {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
      chunks.push(bytes)
      totalLength += bytes.length
      return this
    },
    digest(): Uint8Array {
      const input = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        input.set(chunk, offset)
        offset += chunk.length
      }
      return algorithm === 'md5' ? md5Digest(input) : sha1Digest(input)
    },
  }
}

/** 兼容 default import（nanoid 3.x 以 `import crypto from 'crypto'` 引用）。 */
export default {
  randomFillSync,
  randomBytes,
  randomUUID,
  webcrypto,
  getRandomValues,
  createHash,
}

// nanoid 的 node 版构建引用自由变量 `Buffer.allocUnsafe`、uuid 的 node 版引用
// `Buffer.from`；浏览器无 Buffer 全局，最小补齐使 bundle 可执行。
if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  ;(globalThis as { Buffer?: unknown }).Buffer = {
    allocUnsafe(size: number): Uint8Array {
      return new Uint8Array(size)
    },

    from(value: unknown): Uint8Array {
      if (typeof value === 'string') return new TextEncoder().encode(value)
      if (Array.isArray(value)) return Uint8Array.from(value as number[])
      if (value instanceof Uint8Array) return value
      throw new Error('crypto-shim: Buffer.from 仅支持 string/数字数组/Uint8Array')
    },
  }
}
