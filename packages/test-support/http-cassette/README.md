---
description: "Record real HTTP traffic into JSON cassettes and replay it in tests with ordered consumption and credential redaction, for test authors who need the real wire request and response without a live service."
kind: "package-library"
---

# @deepseek-ai/dsh-test-support-http-cassette

English | [中文](README.zh.md)

## Summary

Use this package to call a real HTTP service once and replay the exact responses afterwards. `createCassetteFetch` returns a `fetch` in record, replay, or automatic mode: matching requests consume cassette entries in order, so retries and polling replay their recorded sequence. JSON bodies match regardless of key order, credential headers and query values never reach the file, and bodies that still look like secrets are refused unless `redact: 'scrub'` is set.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Reach for this package when a test must exercise a real request/response cycle once and then run without the service, when an adapter's retry or polling behavior needs recorded responses in sequence, or when a fixture must prove which request it sends. Hand-written response stubs do not cover these cases.

### Entry point

```ts
import { createCassetteFetch } from '@deepseek-ai/dsh-test-support-http-cassette'

const recorder = createCassetteFetch({ mode: 'auto', dir: 'tests/fixtures/cassettes', name: 'provider/retry' })
const response = await recorder('https://provider.test/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'test', messages: [] }),
})
recorder.assertComplete()
```

The first local run records `tests/fixtures/cassettes/provider/retry.json`; later runs, and any run with `CI` set, replay it. `replay` throws when the cassette is missing, when a request matches no unconsumed entry, or when `assertComplete`/`dispose` finds entries left over. Exact fields and diagnostics live in [`src/index.ts`](src/index.ts).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

Recording overwrites the cassette with the interactions of the current instance, writing through a temporary sibling so a refused write leaves no partial file. Replay reads the cassette once and keeps `used` flags in memory; a request claims the first unconsumed entry with the same method, redacted URL, and canonical body. Canonicalization parses a textual body as JSON and sorts object keys recursively, so key order never affects matching. Textual media types are recorded verbatim; everything else is stored as base64 with an explicit `bodyEncoding`.

### Redaction

Before anything reaches the cassette, headers named `authorization`, `cookie`, `proxy-authorization`, `set-cookie`, `x-api-key`, `x-amz-security-token`, and `x-goog-api-key` are dropped, sensitive query values become `[REDACTED]`, and textual bodies are scanned for `sk-`, `Bearer `, `AKIA`/`ASIA`, `gh[pousr]_`, `AIza`, and private-key headers. A match refuses the write unless the caller passes `redact: 'scrub'`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `createCassetteFetch`, cassette file codec, ordered matching, redaction, and completeness assertions |
| [`tests/http-cassette.spec.ts`](tests/http-cassette.spec.ts) | Real loopback HTTP server cases for recording, replay, ordering, redaction, CI refusal, and binary bodies |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Test-support group map](../README.md) — sibling harnesses and where this package belongs.
- [Testing policy](../../../docs/testing.md) — the tiers of keyless tests this cassette serves.
- [llm-replay](../llm-replay/README.md) — the keyless model-stream counterpart for recorded Session transcripts.

-----

<a id="model-experience"></a>
## Model Experience

None, as this test harness records and replays HTTP traffic without constructing model requests or prompts.

#### KV Cache effect

None; replay returns recorded bytes locally and never contacts a provider.

## Known Limitations and Deferred Work

- **Matching ignores headers and query order** — a replayed request differs from the recorded one only when its method, redacted URL, or canonical body differs; two calls that differ solely in headers share the same entry.
- **Recording overwrites the cassette** — a recording instance starts from an empty cassette, so record every interaction of a scenario in one run.
- **Transfer encodings are not preserved** — response bytes are stored after the HTTP client decodes them, while `content-encoding` and `content-length` stay as received; a later replay serves the decoded bytes with those original headers.
- **Binary request bodies are matched as base64** — textual bodies are canonicalized as JSON; a binary body matches byte-for-byte and never key-normalizes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package depends on Node built-ins only; it has no plugin surface and mounts nothing into a composition.

</details>
