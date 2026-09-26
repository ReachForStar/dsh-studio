---
description: "Configure the Host Remote gateway for querying a2a-host listener and Kafka reachability status."
kind: "package-reference"
---

# @reachforstar/dsh-a2a-status

English | [中文](README.zh.md)

## Summary

Use this package to expose a2a-host listener status and Kafka broker reachability to the Web client. The gateway probes the optional `ctx.a2aHost` service and performs TCP reachability checks against the default Kafka brokers without starting them. It requires the Typert Remote protocol and Host Connection transport.

## Use this package

Mount the gateway in a Web Host composition together with the optional a2a-host plugin, the Connection transport, and the client Remote assembly.

### Minimal configuration

```yaml
- id: a2a-status
  name: '@reachforstar/dsh-a2a-status'
```

The gateway reports `hostRunning: false` when a2a-host is absent and `kafkaReady: false` when no broker is reachable.

## Model Experience

This package has no model-facing surface. The Remote `a2a/status` method returns a status snapshot consumed by the Web client status indicator and entry-visibility logic.

## Known Limitations and Deferred Work

- Kafka reachability uses TCP probing only; it does not start Kafka or verify cluster health beyond broker port reachability.
- The broker list is fixed to the default `127.0.0.1:9092,9093,9094`; environment override (`A2A_BUS_BOOTSTRAP`) is not read here to avoid side effects in a status query.