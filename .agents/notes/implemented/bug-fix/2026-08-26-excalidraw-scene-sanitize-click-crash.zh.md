# Agent Note: 规范化 Excalidraw 场景元素，修复点击画布就崩溃消失

Status: implemented

[English](2026-08-26-excalidraw-scene-sanitize-click-crash.md) | 中文

## Problem

嵌入的 Excalidraw 画布面板（`ExcalidrawPanel`）在用户点击任意图形时突然消失（面板卸载，只剩 DSH 背景）。故障可稳定复现成循环：刷新画布 → 图形正常浮现 → 点击图形 → 整个面板消失 → 刷新 → 图形恢复 → 再点 → 再消失。期间没有 Agent 运行，也没有切换会话。

根因是 `<workspace>/.dsh/excalidraw/scene.json` 场景文件里存在**不属于 Excalidraw 原生 schema 的畸形元素**。出问题的画布场景（一张手工拼装的大型架构图）包含：

- 三个 `zone_*` 矩形（`zone_94a3b8`/`zone_7fb89a`/`zone_b48ec9`），`version: null` 且**没有 `seed`** 字段，同时缺 `angle`/`isDeleted`/`roundness`/`groupIds`/`frameId`/`boundElements`/`link`/`locked`。
- 一个 `image` 元素（`1TZWjMC5GZODShrs7ZDT4`），`status: "pending"`，无配套文件数据。

Excalidraw 在初次 `updateScene` 时容忍这些元素（图形能渲染），但**点击**图形会触发真正的渲染/绑定路径。缺 `seed` 会让 roughjs 在生成路径时抛错（`excalidraw_draw` 工具的注释里就记录了这类失败）；无文件的 `image` 没有可渲染的数据源。抛出的异常被 `SlotErrorBoundary`（scoped-slots）捕获，导致整个面板卸载、只剩背景。刷新重新挂载后循环重复。

前端 poll 循环被排除：`sceneFingerprint` 只比较 `id:type:text`，点击不会改变它，2 秒轮询不会因用户交互重载画布。

## Decision

在 `@deepseek-ai/dsh-tool-excalidraw`（场景契约方，`SCENE_RELATIVE` 所在）新增共享的 `sanitizeScene()` 规范化，并在场景的所有进出边界应用：

- **`excalidraw_service.ts` `/scene/current`** —— 在场景到达面板的 `loadScene` 与 2 秒 poll 前修复，保证画布永远不会收到会让它崩溃的场景。
- **`excalidraw_service.ts` `/scene/write`** —— 在前端自保存回写持久化前修复。
- **`tool-excalidraw` `excalidraw_write`** —— 在模型写入落盘前修复（该工具直接写场景文件，绕过 HTTP 路由）。

`sanitizeScene` 幂等地补全渲染关键默认值：`seed`（对元素 id 做确定性哈希，使重复读取永不改变场景、也永不扰动 `sceneFingerprint`）、`version`（null/undefined → 1）、`angle`/`roundness`，以及形状几何的分组/容器字段。无文件的或 `pending` 的 `image` 元素被剔除（无法渲染）。格式良好的元素原样通过。

另外用一次性脚本（node 直接作用于真实场景文件）修复了损坏的现有场景：389 → 388 个元素，三个 `zone_*` 矩形补齐 `seed`/`angle`/`roundness`/`isDeleted` 并把 `version` 置为 1，pending image 被移除。

## Alternatives considered

**只在前端（`handleChange`/poll）修复。** 拒绝——前端的 `handleChange` 收到的本就是 Excalidraw 自身（格式良好）的元素；畸形数据是从场景文件进入的，因此真正需要规范化的边界是场景读/写。仅前端修复覆盖不到模型 `excalidraw_write` 这条直接写文件的路径。

**用随机 seed 修复。** 拒绝——随机 seed 使规范化非幂等；反复读同一个文件会不断改写它。确定性 id 哈希 seed 跨多次规范化保持稳定。

## Consequences

- 任何来源的场景（用户导入、模型 `excalidraw_write`、历史遗留文件）在面板渲染前都被规范化。
- `sanitizeScene` 从 `@deepseek-ai/dsh-tool-excalidraw` 导出并被 web surface 复用，两条路径共享同一契约，不会漂移。
- 两个原先断言磁盘内容字节相等的 round-trip 测试改为断言修复后（用户字段 + 默认补齐）的等价结果，并新增对畸形元素、被剔除 image、格式良好原样通过三类用例的单元测试。
