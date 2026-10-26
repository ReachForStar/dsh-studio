---
description: "Expose a2a-host listener and Kafka broker reachability to the Web client as a Remote status snapshot."
kind: "package-reference"
---

# @reachforstar/dsh-a2a-status

English | [中文](README.zh.md)

## Summary

Use this package to expose a2a-host listener status and Kafka readiness to the Web client. The gateway probes the optional `ctx.a2aHost` service and ensures Kafka in the background at startup, trying an environment override, an already running cluster, Docker, then WSL; when it cannot become ready it returns a failure category and the raw diagnostic with the snapshot. It requires the Typert Remote protocol and Host Connection transport.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the gateway in a Web Host composition together with the optional a2a-host plugin, the Connection transport, and the client Remote assembly.

### Minimal configuration

```yaml
- id: a2a-status
  name: '@reachforstar/dsh-a2a-status'
```

The gateway reports `hostRunning: false` when a2a-host is absent, and `kafkaReady: false` plus a failure category when Kafka is not ready.

| Field | Meaning |
|---|---|
| `kafkaPhase` | `starting` while probing or starting, `ready` when reachable, `unavailable` when not |
| `kafkaFailure` | Why it is not ready: `no-runtime` (no Docker and no WSL), `start-failed` (the start command failed), `not-listening` (the command ran but no broker listened); `null` when ready |
| `kafkaDiagnostic` | Raw text such as the start command exit code and stderr; empty when there is no detail |

The failure category is a structured vocabulary and the client locale dictionary owns the display copy, so one snapshot renders correctly in both Chinese and English.

<a id="model-experience"></a>
## Model Experience

None, as the gateway only reports listener and broker reachability to the browser.

#### KV Cache effect

No direct effect; the snapshot never enters a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Readiness uses TCP port probing only; it does not verify cluster health beyond broker port reachability (partitions, ISR, topic configuration).
- Kafka is ensured by a background task at startup, so this gateway does start containers on the host; a deployment that must only observe should start the cluster itself first.
- The broker list is fixed to the default `127.0.0.1:9092,9093,9094`; `A2A_BUS_BOOTSTRAP` is not read here, so a status query has no side effects.

<a id="dev-note"></a>
### Dev Note

The gateway is a package of its own because [`dsh-a2a-host`](../a2a-host/README.md) is optional: a deployment that mounts only the outbound [`dsh-a2a`](../a2a/README.md) service still serves this status query, which reports the absent listener instead of failing to load.
