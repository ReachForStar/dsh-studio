---
description: "A2A host and Kafka status inside Web Settings, plus the a2aStatus store other browser packages read."
kind: "package-reference"
---

# @reachforstar/dsh-client-ui-a2a-status

English | [中文](README.zh.md)

## Summary

Use this package to show A2A host and Kafka status inside Web Settings. The browser half reads the `a2a/status` Remote served by [`dsh-a2a-status`](../../a2a/a2a-status/README.md), renders the snapshot as one settings section, and provides the `a2aStatus` store so other browser packages read the same snapshot. The Host half ships no behavior of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in a Web composition whose Host already mounts the status gateway and the Remote assembly. The section appears under Settings, reads the snapshot when it mounts, and offers a retry when that read fails.

### Minimal configuration

```yaml
- id: ui-a2a-status
  name: '@reachforstar/dsh-client-ui-a2a-status'
```

The plugin requires the `slots`, `locale`, and `remote` services plus the `remote.a2a` namespace.

<a id="model-experience"></a>
## Model Experience

None, as the section only renders a browser-facing status snapshot.

#### KV Cache effect

No direct effect; the snapshot never enters a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The section reports what the gateway answered. It starts neither Kafka nor the a2a-host listener, so "not running" describes this deployment rather than a defect in the section.
- Mounting this browser half without the [`dsh-a2a-status`](../../a2a/a2a-status/README.md) Host gateway shows a failed read with the retry control instead of an empty section.

<a id="dev-note"></a>
### Dev Note

The status surface is split in two packages: [`dsh-a2a-status`](../../a2a/a2a-status/README.md) owns the Host Remote gateway, and this browser package owns presentation plus the `ctx.a2aStatus` store. A headless composition therefore keeps the gateway without the browser half, and the section's copy lives in the client locale dictionary rather than on the wire.
