---
description: "配置 Host Remote 网关，查询 a2a-host 监听状态和 Kafka 可达性。"
kind: "package-reference"
---

# @reachforstar/dsh-a2a-status

[English](README.md) | 中文

## 摘要

本包向 Web 客户端暴露 a2a-host 监听状态和 Kafka broker 可达性查询。网关探测可选的 `ctx.a2aHost` 服务，并对默认 Kafka broker 做 TCP 可达性检测，不启动它们。需要 Typert Remote 协议和 Host Connection 传输。

## 使用本包

在 Web Host 组合中，与可选的 a2a-host 插件、Connection 传输和客户端 Remote 装配一起挂载本网关。

### 最小配置

```yaml
- id: a2a-status
  name: '@reachforstar/dsh-a2a-status'
```

a2a-host 缺失时报告 `hostRunning: false`，无 broker 可达时报告 `kafkaReady: false`。

## 模型体验

本包无模型可见面。Remote `a2a/status` 方法返回状态快照，供 Web 客户端状态指示器和入口显隐逻辑消费。

## 已知限制与待办

- Kafka 可达性仅用 TCP 探测，不启动 Kafka，也不验证 broker 端口可达之外的集群健康。
- broker 列表固定为默认 `127.0.0.1:9092,9093,9094`；此处不读环境变量覆盖（`A2A_BUS_BOOTSTRAP`），避免状态查询产生副作用。