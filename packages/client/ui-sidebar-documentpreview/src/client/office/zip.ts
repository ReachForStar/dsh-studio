/**
 * Zip access for the office renderers, over `fflate`.
 *
 * An OOXML document is a zip of XML parts. Reading one means unpacking every
 * part, because a rebuild must write back the parts it did not touch; writing
 * one means packing them again in the same shape. `fflate` is a maintained,
 * dependency-free implementation of exactly this, so nothing here hand-rolls
 * DEFLATE or a central directory.
 */
import { unzipSync, zipSync } from 'fflate'

/** Every part of one archive, keyed by its in-archive path. */
export type ZipParts = Record<string, Uint8Array>

/**
 * Unpack an archive.
 * @param bytes - the complete archive.
 * @returns its parts, keyed by path.
 */
export function unzipParts(bytes: Uint8Array): ZipParts {
  return unzipSync(bytes)
}

/**
 * Pack parts into an archive. Compression level 6 is zlib's default: a
 * document's XML compresses by roughly an order of magnitude there, and the
 * extra time a higher level costs buys little on text this redundant.
 * @param parts - parts to write, keyed by path.
 * @returns the complete archive.
 */
export function zipParts(parts: ZipParts): Uint8Array {
  return zipSync(parts, { level: 6 })
}

/**
 * Decode one part as UTF-8 XML.
 * @param parts - archive parts.
 * @param path - the part to decode.
 * @param what - the format being read, named in the failure.
 * @returns the part's XML source.
 */
export function xmlPart(parts: ZipParts, path: string, what: string): string {
  const part = parts[path]
  if (part === undefined) throw new Error(`${what}: the archive has no ${path}`)
  return new TextDecoder().decode(part)
}

/**
 * Encode XML back into one part, replacing it in place.
 * @param parts - archive parts, mutated at `path`.
 * @param path - the part to write.
 * @param xml - the serialized XML.
 */
export function setXmlPart(parts: ZipParts, path: string, xml: string): void {
  parts[path] = new TextEncoder().encode(xml)
}
