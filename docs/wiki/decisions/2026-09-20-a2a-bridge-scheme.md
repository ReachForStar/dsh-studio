---
title: A2A 对接改用 a2a-bridge 方案（双通道 + skill 契约）
type: decision
tags: [a2a, 架构, 决策, bridge, kafka]
created: 2026-09-20
updated: 2026-09-20
sources: []
status: active
---

# A2A 对接改用 a2a-bridge 方案（双通道 + skill 契约）

## 背景（现状与约束）

专家席（天权/瑶光/天梁）此前只走本栈自带的直连通道：harness 作为 A2A 客户端逐个 HTTP 调 `127.0.0.1:<端口>`，对等端地址写在本机 profile 的 `a2a.peers` 里，派发只带一段文本。约束与不足：

- 只有同步通道，长任务受 HTTP 超时与调用方进程寿命约束；网关重启即丢失在途任务。
- 对等端地址与 skill 语义在两边各写一份，容易漂移；调用方不知道对端接受哪些 skill。
- 本机已有 `D:/file/a2a-bridge`（GitHub `ReachForStar/a2a-bridge`）与其 Kafka 三 broker 集群（WSL docker，`127.0.0.1:9092/9093/9094`），bridge 已提供三个 A2A v1.0.1 网关与一整套总线语义。

## 备选方案

1. **保持现状，只把端口写全**：改动最小，但长任务与重启恢复仍然无解，skill 契约继续缺失。
2. **直接依赖 bridge 的 `@a2a-bridge/shared` 包**：省掉自己实现，但那是未发布的跨仓本地包，会把 harness 的构建与发布绑到另一个仓库的目录布局上。
3. **在 harness 内实现同一套方案**（选定）：线格式与总线语义按 bridge 的规范实现，配置直接读 bridge 的 `config/config.json`，两边共用一份端口/skill/topic 定义。

## 决策（选定方案）

`@reachforstar/dsh-a2a` 增加 Kafka 总线与桥配置装载，`a2a` 服务新增 `dispatch()`：

- `bridge.configPath` → bridge 的 `config.json`；三个 agent 的 URL 由其中端口派生，`skills(agent)` 由技能映射派生；`A2A_CONFIG`/`A2A_API_KEY`/`A2A_BUS_BOOTSTRAP`/`A2A_PI_MODEL`/`A2A_OC_MODEL` 与 bridge 同义。
- 派发两通道：`direct`（JSON-RPC 流式，收集工件文本与终态）与 `bus`（投 `a2a.task`，可 `wait` 终态事件）。
- 席位带 skill 与通道：`seats.<role>.skill`（默认天权 `code-review`、瑶光与天梁 `analysis`）、`seats.<role>.channel`（默认 `direct`；`bus` 席位自动 `wait: true`，否则席位无话可说）。

## 理由（决策依据）

- **配置单一来源**：端口的唯一事实在 bridge 的 `config.json`，两边不会再漂移；harness 侧只剩「指向哪个文件、自称什么名字」。
- **不使用跨仓包依赖**：方案是协议与语义，不是那份实现；自己实现保持在 harness 的构建、类型与覆盖率门禁之内。
- **总线确有需要**：分波交付计划一类的长任务在直连下会被 HTTP 超时与网关重启打断，总线带重投、DLQ、事件回放与消费者自恢复。
- **skill 是权限边界**：bridge 按 skill 收紧工具白名单（cc 的 `code-review` 只读、`coding` 可写），不传 skill 就等于让对端按默认权限跑。

## 后果（影响与后续）

- `a2a` 行不必再逐条写 peers；模型侧的 `a2a_send` 增加 `skill`/`workspace`/`mode`/`wait`，`a2a_peers` 会列出每个对等端接受的 skill。
- 新增运行时依赖 `kafkajs@2.2.4`（与 bridge 同版本）。
- A2A 席位仍然没有自己的超时：`seats.<role>.timeoutMs` 只作用于 `local` 席位，A2A 席位由对端网关的 `taskTimeoutMs` 收尾。
- 总线任务在 A2A 任务表里的可见性取决于 bridge 网关（实测未并入，见[实测页](../queries/a2a-bus-task-visibility.md)）；harness 侧不依赖该可见性。
- 关闭总线不发通知：`close()` 只停消费者与生产者，不投递终态事件。

## 关联

- [A2A 栈](../entities/a2a-stack.md) · [星域多智能体协作](../entities/xingchen-multi-agent.md) · [专家席经 A2A 抵达](2026-09-19-xingchen-external-specialist-seats.md)
