---
description: "Expose a2a-host listener and Kafka broker reachability to the Web client as a Remote status snapshot."
kind: "package-reference"
---

# @reachforstar/dsh-a2a-status

English | [中文](README.zh.md)

## Summary

Use this package to expose a2a-host listener status and Kafka broker reachability to the Web client. The gateway probes the optional `ctx.a2aHost` service and performs TCP reachability checks against the default Kafka brokers without starting them. It requires the Typert Remote protocol and Host Connection transport.

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

The gateway reports `hostRunning: false` when a2a-host is absent and `kafkaReady: false` when no broker is reachable.

<a id="model-experience"></a>
## Model Experience

None, as the gateway only reports listener and broker reachability to the browser.

#### KV Cache effect

No direct effect; the snapshot never enters a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Kafka reachability uses TCP probing only; it does not start Kafka or verify cluster health beyond broker port reachability.
- The broker list is fixed to the default `127.0.0.1:9092,9093,9094`; environment override (`A2A_BUS_BOOTSTRAP`) is not read here to avoid side effects in a status query.

<a id="dev-note"></a>
### Dev Note

The gateway is a package of its own because [`dsh-a2a-host`](../a2a-host/README.md) is optional: a deployment that mounts only the outbound [`dsh-a2a`](../a2a/README.md) service still serves this status query, which reports the absent listener instead of failing to load.
