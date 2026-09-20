---
title: 会话格式 v4：席位答复以 assistant 角色进模型可见内容
type: query
tags: [session-format, surface, 迁移, xingchen, a2a, 待实施]
created: 2026-09-20
updated: 2026-09-20
sources: []
status: active
---

# 落到 v4 的交接：席位答复以 assistant 角色进模型可见内容

> 状态：**已实施**（2026-09-24，写入器 v4）。本页保留需求、证据、落地清单与实施结果。代际机制与「新增一代」的顺序见 [会话格式代际](../concepts/session-format-generations.md)。

## 为什么必须动会话格式（三条证据）

1. **surface 只认固定四种事件**：`packages/core/session/src/surface.ts` 的 `SURFACE_EVENT_TYPES = {system/message, user/message, assistant/message, tool/result}`；`surfaceMessage()` 是核心内的 `switch`，插件事件走 `default → null`，**插件无法自行新增模型可见消息**。
2. **`@messageProjection` 不改写 surface**：其语义是「改既有消息内容」，`project()` 返回 `Map<原 seq, Message>`（`image/offload` 即删图片），不能新增消息。
3. **免轮次的 surface 事件只有 `user/message`**：`system/message` 与 `assistant/message` 的载荷强制 `turn`/`step`（`assistant/message` 还要 `stream`），而命令路径跑在轮次之外（命令会话没有 `turn/start`，`session.blank` 恒为 true）。填 0 就是往日志写假结构，禁止。

**版本结论**：版本机制笔记（`.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md`）原文把「the surface mechanism (`SurfaceEventType` set, `SurfaceOp` variants)」列为必须 bump 的结构性改动；「普通事件新增不 bump」只适用于**非 surface** 事件。因此新增 `assistant/peer-message` **必须 bump `SESSION_FORMAT_VERSION`**。

## 落地清单（顺序不可调换）

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | `packages/session/session-format-v3-to-v4/` | **新建一代迁移包**（见下方清单）。必须先于或同时于第 2 步：`createSessionFormatChain` 校验相邻链唯一且完整，缺一代直接抛错，会话持久化拒绝初始化 |
| 2 | `packages/core/session/src/types.ts` | `SESSION_FORMAT_VERSION` 3 → 4；`SessionEventMap` 增 `assistant/peer-message: { message: AssistantMessage }` |
| 3 | `packages/core/session/src/surface.ts` | `SURFACE_EVENT_TYPES` 与 `surfaceMessage()` 增该分支（沿用「空内容不入 surface」） |
| 4 | 生成物与登记 | `gen-persistence-catalog`（`known-event-types.ts`）、`session-format-catalog` 的相邻边、`tsconfig.host.json` 引用、`packages/session/README*` 代际说明 |
| 5 | `packages/xingchen/xingchen` | 声明合并 `MessageSourceMap['a2a-seat'] = { kind:'a2a-seat'; role; agent; skill }`（**不伪造 provider/model**）；命令路径成功后 append 该事件 |
| 6 | `packages/client/ui-chat` | 增一个 Definition 渲染该事件（否则落 `UnknownSurfaceNode` 兜底）；`ui-polish` 的 flow Definition 认它 |
| 7 | 文档 | `docs/architecture.md`（surface 一节）、`docs/session-format-status.md`；双语配对用 `pnpm run verify-translation-pairing --write <pair>` 记录 |

## 一代迁移包的确切清单（照 `session-format-v2-to-v3` 镜像）

```
package.json          tsconfig.json        tsdown.config.ts
README.md  README.zh.md  README.i18n.yaml       ← 三件套 + i18n 配对，门禁必查
src/index.ts  src/codec.ts  src/migration.ts
src/payload.ts  src/references.ts  src/validation.ts
tests/*.spec.ts
```

**`package.json` 必须带代际清单块**（`verify-*` 门禁按它解析链）：

```json
"dsh": { "sessionFormatMigration": {
  "from": 3, "to": 4, "export": ".",
  "migration": "sessionFormatV3ToV4",
  "sourceCodec": "releasedV3SessionFormatCodec",   // 从 v2-to-v3 包转出
  "targetCodec": "releasedV4SessionFormatCodec",   // 本包冻结
  "targetHeaderValidator": "assertReleasedV4Header",
  "targetRestorer": "restoreReleasedV4Artifact"
}}
```

**`defineSessionFormatMigration` 契约**（`packages/session/session-format/src/chain.ts`）：强制 `toVersion === fromVersion + 1`；必填 `migrateHeader` / `createStage` / `validateTargetHeader`；阶段实现 `transformEvent` / `transformRun` / `finish`，输入带 `sourceKind: 'decoded' | 'transformed'`。

**v3→v4 可以写得很小**（这一代只承认一个新事件类型，头结构与事件信封都不变）：`migrateHeader` = 校验 v3 头 → `{...header, version: 4}`；`createStage` = 逐事件原样下发（v2→v3 的 `remapEvent`/`canonicalizeTransformedEvent` 在这一代用不上）；`assertReleasedV4Header` 照 `v2-to-v3/src/validation.ts` 的 `assertReleasedV3Header` 复制成 v4（v2→v3 复用 v1→v2 是既有先例）。

## 动手前必读

`session-format-v2-to-v3/src/{codec,payload,references,validation,migration}.ts`。这些代码的职责是把用户磁盘上的历史日志安全升到新格式——**写错不会报错，而是静默迁移错日志**，是本仓库最高危的失败模式。不要在未读完这些实现的情况下用猜测镜像。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| `user/message` + 插件来源 | 免轮次、不碰格式，但模型侧看到的是 user 角色内容，不满足需求 |
| 复用 `system/message` | 强制 turn/step，命令路径无轮次可填 |
| 伪造 `assistant/message` 的 model source | 会把对端 provider/model 记进本会话的计价口径，且伪造 turn 结构 |
| 只做界面呈现（`assistant/attempt` + 客户端气泡） | 不进模型可见内容，只解决观感 |

## 实施结果（2026-09-24）

按上表 1→7 落地，写入器升到 **v4**：

- 新包 `packages/session/session-format-v3-to-v4`：恒等体迁移 + 冻结的 V4 编解码器 + V4 产物校验器 + 载荷校验器，自带双语 README 与 8 项迁移测试。
- 核心：`SESSION_FORMAT_VERSION = 4`；`SessionEventMap` 增 `assistant/peer-message: { message: PeerAssistantMessage }`；`SurfaceEventType` 与 `SURFACE_EVENT_TYPES` 增该类型；`surfaceMessage()` 按助手消息投影。`llm` 侧新增 `PeerAssistantMessage`（`source: Exclude<MessageSource, ModelMessageSource>`，从类型上禁止它冒充本会话模型）与 `createPeerAssistantMessage`。
- xingchen：`MessageSourceMap['a2a-seat']` 声明合并；命令路径成功后 append 该事件（自带的测试断言 role/source/内容）。
- 客户端：`ui-chat` 增 `peer-message` Definition 与卡片渲染器（复用 `AssistantMarkdown`），locale 增 `message.peerAnswer`；`session-reference` 投影与 `session-log-deepseek` 线格式同步。
- 文档：新包双语 README、`docs/persistence-changes/historical-formats/v3.{md,zh.md}` 历史参考（62 根 / 482 类型）、`docs/subsystems/session.md` 的 type-equiv 区块。

**实际改动比预估多出的两处**（已写入 [代际页](../concepts/session-format-generations.md) 的踩坑小节）：冻结的 v3 校验器无法把新 surface 类型读成不透明事件，所以 v4 校验器不整份委托给 v3；行级准入必须只做窄检查，否则会把存储态的范围形式 `sourceEventSeqs` 判死。

**验证**：`typecheck`（两面）、`test:docs` 20 项门禁、`verify-package-dependencies`、相关包 vitest（core/session + session/* 2447、xingchen 41、ui-chat 与回放 901、ui-conversation/ui-polish/ui-trajectory 745）全绿；客户端与前端产物重建后网页实测无 error/warn。
