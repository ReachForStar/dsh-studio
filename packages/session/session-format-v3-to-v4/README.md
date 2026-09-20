---
description: "The adjacent V3-to-V4 Session conversion: one admitted surface event, the turn-free peer assistant message, and the vocabulary checks that stay with their own generation."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v3-to-v4

English | [中文](README.zh.md)

## Summary

Restore supported released V3 Sessions as V4. The edge is an identity conversion for event bodies: it admits one additional surface event, `assistant/peer-message`, which carries an assistant message another agent produced for this Session outside its own loop. Persistence consumes the edge through the static catalog; the library does not read or publish files.

## Table of Contents

- [Use this package](#use-this-package)
- [V3-to-V4 specification](#v3-to-v4-specification)
  - [Header](#header)
  - [Event bodies](#event-bodies)
  - [The peer assistant message](#peer-assistant-message)
  - [Refusal](#refusal)
- [Native V4 admission](#native-v4-admission)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use the [catalog](../session-format-catalog/README.md) to restore a Session. Direct imports serve catalog assembly and tests; this library has no Cordis mount configuration. The [public exports](src/index.ts) provide the migration declaration, the frozen V3 source codec, the V4 target codec, the target header validator, and the target restorer.

### Entry point

The header-only operation rewrites the version field and nothing else:

```text
const targetHeader = sessionFormatV3ToV4.migrateHeader(sourceHeader)
```

Full restoration feeds decoded events through a fresh stage. Callers must not treat partial stage emissions as a successful restore: an error can occur at a later event or at `finish()`. The [format protocol](../session-format/README.md) owns stage scheduling and catalog error handling; [JSONL persistence](../session-persistence-jsonl/README.md) owns read preparation and immutable successor publication.

-----

<a id="v3-to-v4-specification"></a>
## V3-to-V4 specification

<a id="header"></a>
### Header

The logical header changes `version: 3` to `version: 4`. Every other field, including `backend`, `agentPreset`, `cwd`, `parentSession`, and `origin`, is retained unchanged. The physical header line gains no field, so the V4 codec delegates framing to the frozen V3 codec after rewriting the version it checks.

<a id="event-bodies"></a>
### Event bodies

Every released V3 event is valid V4 input and is emitted verbatim: sequence positions, timestamps, message identities, payloads, embedded assistant streams, and audited references keep their values. The edge inserts no event, so no local reference or inherited cut needs remapping. A seeded Session's tagged inherited cut maps to the same target position; a supplied `sourceInheritedEventCount` must agree with it, and a seeded log without a marker or an unseeded log with one is refused exactly as in the preceding edges.

<a id="peer-assistant-message"></a>
### The peer assistant message

`assistant/peer-message` carries `data.message`: an assistant message with an `id`, `role: 'assistant'`, `content`, and a `source` naming the producing agent. It has no turn, step, or provider stream because the producing agent ran outside this Session's loop, and it requires the same `surfaceOp` marker as every other surface event. It embeds its own message, so it forbids `sourceEventSeqs`.

Its `source` must not be a model source. A model source would claim this Session's model route for another agent's answer, misattributing the producer and the usage accounting keyed off it; both the durable read path and this validator refuse it. Installed sources name the peer and the skill it ran under.

<a id="refusal"></a>
### Refusal

A required event type outside the installed vocabulary refuses the artifact, naming the type and its sequence. Surface replacements still cannot shadow a protected system head, a system message must match an open step, and compaction cannot shadow the protected head. Events must stay dense from zero. The edge performs no repair, generation fallback, or file rewrite.

-----

<a id="native-v4-admission"></a>
## Native V4 admission

Input already marked V4 does not run V3-to-V4. Native catalog reads with `validation: 'transformed'` apply codec checks only; full relationships require `restoreReleasedV4Artifact` or catalog `validation: 'current'`. V4 validation replicates the V3 relationship rules over the widened surface set. It does not delegate to the frozen V3 restorer: a predecessor validates an unclassifiable type as opaque, which is what a newer surface type needs, while the frozen V3 rules would read `assistant/peer-message` as a known non-surface type and refuse its `surfaceOp`. The predecessor chain still owns those rules for V3 and older artifacts, and the installed current validation runs after this restorer on the live path.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [stage](src/migration.ts) emits each admitted event at its source coordinates and tracks only the inherited cut. The [codec](src/codec.ts) wraps the frozen V3 codec: it rewrites the physical version for the frozen decoder, validates this generation's structural rows before recovery, and validates decoded events after the frozen decoder expanded stored `sourceEventSeqs` ranges. The [restorer](src/validation.ts) owns the relationships described above. The [payload validator](src/payload.ts) owns the widened surface set and the peer-message payload rules. No runtime invariant companion is published because this library owns no independently observable registrations or state replicas.

This generation's surface event is masked from the frozen predecessor vocabulary when an artifact is validated, because that vocabulary predates the type and would refuse its `surfaceOp`. The [catalog](../session-format-catalog/README.md) assembles the complete adjacent chain from [package manifests](../../../docs/session-format-status.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Released V2 to V3](../session-format-v2-to-v3/README.md) — the frozen preceding conversion and its source codec.
- [Session format release status](../../../docs/session-format-status.md) — the writer version and the published version record.
- [Released-format policy](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) — why ancestors stay frozen and successors are added.

-----

<a id="model-experience"></a>
## Model Experience

### Peer answers

#### What the model sees

A peer answer (`assistant/peer-message`) reaches the provider transcript as an assistant message, in log order, with its recorded content. The edge itself adds no model-visible text to a converted Session: an unchanged V3 log produces the same requests it did before.

#### Token effect

Conversion adds no tokens. A logged peer answer costs whatever its recorded content costs when a later request includes it.

#### KV Cache effect

The edge preserves historical request meaning; it does not guarantee provider cache hits or byte-identical native V4 recordings.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No turn coordinates on peer answers** — the producing agent ran outside this Session's loop, so a peer answer carries no turn or step and does not join Turn grouping in the transcript.
- **No file or settings migration** — this package never changes committed generations or `settings.yaml`. Persistence owns publishing the final successor; an existing V4 generation does not rerun its incoming edge.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
