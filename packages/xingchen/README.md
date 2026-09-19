---
description: "Choose the star-domain routing package and its agent presets for a four-role session."
kind: "package-group"
---

# xingchen/ — star-domain roles

English | [中文](README.zh.md)

## Summary

The group carries the Xingchen (星辰) star-domain routing: one package that turns a session's work into four roles — 启明 as the native router and 天权/瑶光/天梁 as A2A specialist seats — together with the presets that compose it. See the [Xingchen subsystem reference](../../docs/subsystems/xingchen.md) for the generated service and session-projection API.

## Table of Contents

- [Packages](#packages)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`xingchen/`](xingchen/README.md) | Registers the `xingchen_route` delegation tool, the `/review` `/bug` `/planning` commands, the routing prompt section, and the `xingchen` role/stop-reason session projection over configured A2A peers. | `ctx.xingchen` |

The presets that mount it ship with [`@deepseek-ai/dsh-agent-presets`](../preset/agent-presets/README.md): `standard` adds the routing rows to the default composition, and `xingchen-qiming` is the same composition with the 启明 persona.
