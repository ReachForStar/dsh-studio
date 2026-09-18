---
title: A2A 栈（dsh-a2a / dsh-a2a-host / dsh-tool-a2a）
type: entity
tags: [a2a, 协议, 跨 agent, 出站调用, fork 扩展]
created: 2026-09-17
updated: 2026-09-18
sources: []
status: active
---

# A2A 栈（dsh-a2a / dsh-a2a-host / dsh-tool-a2a）

fork 自研的 Agent2Agent 支持，位于 `packages/a2a/`，三个包都是 `@reachforstar/*`（不进上游文档图生成器）。设计取舍见 [Agent Note](../../../.agents/notes/implemented/feature/2026-09-17-a2a-endpoint-and-peers.md)。

## 包与职责

| 包 | 职责 | 关键文件 |
| --- | --- | --- |
| `@reachforstar/dsh-a2a` | 协议层与对等端接缝：A2A v1.0.1 线协议类型、请求处理器与监听器、客户端、内存任务表、`a2a` 服务 | `src/{schema,server,client,task-store,index}.ts` |
| `@reachforstar/dsh-a2a-host` | 宿主端点：构建 agent card、绑定监听器、以会话为后端驱动一轮 | `src/{index,executor,card}.ts` |
| `@reachforstar/dsh-tool-a2a` | 面对模型的两个工具：`a2a_peers`、`a2a_send` | `src/index.ts` |

接线位置：`packages/bundle/base/cordis.patch.yml` 挂 `a2a` 与 `tool-a2a`；`packages/bundle/web-app/cordis.patch.yml` 挂 `a2a-host`（`port` 取 `DSH_A2A_PORT`，默认 9310；`apiKey` 取 `DSH_A2A_API_KEY`）。

## 关键设计

- **零第三方运行时依赖**：服务端与客户端只用 `node:http`；不用官方 SDK（会带入 gRPC/protobuf 与 Express 形状的服务端）、不用消息中间件。协议面自己拥有。
- **任务标识 = 会话 id**：A2A `contextId` 直接作为 dsh `SessionId`（`SessionId` 仅 brand，无格式校验），因此复用 `contextId` 即续接同一会话。端点因此视为可信调用方，以部署级 `apiKey` 作信任边界。
- **完成信号**：以持久事件 `turn/end` 判定一轮结束，而不用空闲启发式；执行器只消费自己那条 `user/message`（按 `requestId` ↔ `source.rpcId` 比对）之后的帧，避免与别的客户端并发驱动的轮次串台。
- **端点自带监听器**：默认绑定 `127.0.0.1:9310`，而非挂在浏览器服务路径前缀下——对等端按 `origin + /.well-known/agent-card.json` 发现，前缀会迫使每个对等端额外配置卡片路径。`apply` 等待绑定完成，端口占用会让组合直接失败。
- **对等端只来自配置**：模型工具不能注册对等端，出站调用被限制在运维批准过的端点内。
- **任务表不落盘**：至多 500 条、淘汰最旧终态任务，重启即忘；持久历史在会话日志。
- **推送到点拒绝**：四个 push-config 方法返回 `-32003 PUSH_NOTIFICATION_NOT_SUPPORTED`，不假装支持；卡片只声明 JSONRPC 绑定，未声明 `extendedAgentCard`，故 `GetExtendedAgentCard` 回 `-32004`。
- **v1.0.1 符合性（2026-09-18 补齐）**：发往终态任务的消息与订阅终态任务回 `-32004`、取消终态任务回 `-32002`（`SubscribeToTask` 的拒绝抢在 SSE 头之前，错误走 JSON-RPC 应答）；`A2A-Version` 头由 `A2A_PROTOCOL_VERSION` 单一常量拥有（客户端发 `1.0`、服务端只收 `1.0`、缺省/空按规范视为 0.3 并回 `-32009`）；`ListTasks` 按 status timestamp 降序 + base64url 游标分页、`includeArtifacts: false` 整体省略 artifacts（行类型 `A2ATaskRow`）；`historyLength: 0` 省略 history；`contextId` 与 `taskId` 不匹配回 -32602。明细与修法见 [符合性缺口页](../queries/a2a-v1.0.1-conformance-gaps.md)。

## 踩坑

- **Loader 的 `unwrapExports` 会吃掉带 default 导出的模块**：三个包最初都写了 `export default apply|Service`，结果是 `inject` 与 `Config` 被静默丢掉，启动时报 `tool-a2a: cannot get property "tools" without inject`、 `a2a: Cannot read properties of undefined (reading 'peers')`。 修法：**不写 default 导出**，只导出 `name` / `inject` / `apply`（`vendor/loader/src/index.ts` 的 `unwrapExports` 执行 `exports.default ?? exports`）。详见[事故记录 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)。
- **新包必须登记进 `tsconfig.host.json`**：否则类型感知 lint 拿不到 tsconfig program，`packages/*/*/src` 下的值全被当成 `any`，冒出一大片 `no-unsafe-assignment` 假报错（登记后同一批文件立即干净）。
- **`vi.mock`/测试里的 `expect.any(...)` 传入对象字面量会被 `no-unsafe-assignment` 命中**：仓库既有做法是就地加 `as string`（见 `packages/api/session-controller/tests/agent.host.spec.ts`）。

## 已知限制与待办

- gRPC / HTTP+JSON 绑定未实现，卡片也未声明。
- 严格版本：只服务 `A2A-Version: 1.0`，不带版本头（= 0.3）的调用方被 `-32009` 拒绝。
- 无推送通知；模型侧 `a2a_send` 等整轮结束，不向模型流式输出。
- 只处理文本 part；文件与结构化 part 不翻译。
- 覆盖率：`packages/a2a/*/src` 约 96% 语句 / 88% 分支，剩余为可选配置的 `? :` 分支，追 100% 需补组合用例。

## 关联

- [会话宽度轴](../concepts/conversation-width-axis.md) 同属本批 fork 改动。
- 上游文档图生成器只收录 `@deepseek-ai/dsh-*`，故 `apps/cli/composition.md` 不含本栈。
