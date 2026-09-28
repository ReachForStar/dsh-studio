import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact } from '@deepseek-ai/dsh-session-format'
import { releasedV5SessionFormatCodec } from '../codec.ts'

/**
 * Validate an artifact through the native codec without vocabulary-aware restoration.
 * @param artifact - current-generation artifact to encode and decode.
 */
export function assertReleasedV5Artifact(artifact: SessionFormatArtifact): void {
  const codec = releasedV5SessionFormatCodec
  const decoder = codec.createDecoder(codec.encodeHeader(artifact.header, artifact.inheritedEventCount), 'strict')
  const output = new SessionFormatEventCollector()
  for (const event of artifact.events) decoder.decodeRow(codec.encodeEvent(event), output)
  decoder.finish(output)
}
