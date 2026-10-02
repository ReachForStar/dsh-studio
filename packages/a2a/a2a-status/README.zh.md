---
description: "把 a2a-host 监听器与 Kafka broker 可达性作为 Remote 状态快照提供给 Web 客户端。"
kind: "package-reference"
---

# @reachforstar/dsh-a2a-status

[English](README.md) | 中文

## 概述

本包把 a2a-host 监听状态与 Kafka broker 可达性提供给 Web 客户端。网关探测可选的 `ctx.a2aHost` 服务，并对默认 Kafka broker 做 TCP 可达性检查，但不启动它们。它需要 Typert Remote 协议与 Host Connection 传输。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web Host 组合里挂载本网关，同时挂载可选的 a2a-host 插件、Connection 传输与客户端 Remote 装配。

### 最小配置

```yaml
- id: a2a-status
  name: '@reachforstar/dsh-a2a-status'
```

a2a-host 缺失时网关报告 `hostRunning: false`，无 broker 可达时报告 `kafkaReady: false`。

<a id="model-experience"></a>
## 模型体验

无——本网关只把监听器与 broker 可达性报告给浏览器。

#### KV Cache effect

无直接影响；该快照不进入模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Kafka 可达性仅用 TCP 探测，不启动 Kafka，也不验证 broker 端口可达之外的集群健康。
- broker 列表固定为默认 `127.0.0.1:9092,9093,9094`；此处不读环境变量覆盖（`A2A_BUS_BOOTSTRAP`），避免状态查询产生副作用。

<a id="dev-note"></a>
### 开发备注

本网关独立成包，是因为 [`dsh-a2a-host`](../a2a-host/README.zh.md) 是可选的：只挂载对外调用的 [`dsh-a2a`](../a2a/README.zh.md) 的部署仍然能提供这条状态查询，由它报告监听器缺失，而不是加载失败。
