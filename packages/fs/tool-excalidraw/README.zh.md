---
description: "使用面向模型的 Excalidraw 工具读取、写入、绘制并导出工作区白板场景。"
kind: "package-reference"
---

# @reachforstar/dsh-tool-excalidraw

[English](README.md) | 中文

## 概述

Agent 需要检查、替换、扩展或导出 Web 画布显示的同一 Excalidraw 场景时使用本包。工具把场景和导出路径限制在所属工作区内，并返回有界摘要，避免无界场景数据进入结果。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把这些工具挂载到会话归属已知工作区的 agent preset。

### 何时选择

模型与 Web 画布需要编辑同一份工作区白板时选择本包。没有 Workspace 注册表，或导出需要 roughjs 纹理渲染时不应选择。

### 最小配置

```yaml
- id: tool-excalidraw
  name: '@reachforstar/dsh-tool-excalidraw'
```

本包没有配置字段；精确的模型可见 schema 以生成的[工具目录](../../../docs/tool-catalog.zh.md#reachforstardsh-tool-excalidraw)为准。

-----

## 场景工具

**模型面向的 Excalidraw 场景工具**——`excalidraw_read`、`excalidraw_write`、`excalidraw_draw` 与 `excalidraw_export`——作用于 web 画布标签页渲染的工作区场景文件。本包拥有工具名称、JSON schema、参数校验与结果格式化；场景文件位于 `<workspace>/.dsh/excalidraw/scene.json`（`SCENE_RELATIVE`），与 `@reachforstar/dsh-client-ui-polish` 的 `/scene` 路由持久化的是同一个文件。web 表面与模型由此编辑同一块画布。

```ts ignore-check
// A preset composes the tools into an agent alongside the workspace registry.
- id: tool-excalidraw
  name: '@reachforstar/dsh-tool-excalidraw'
```

在 agent 预设中挂载该行（内置 `standard` 预设已包含）。工具从调用 agent 的会话推导目标工作区：会话归属已知工作区时使用该工作区路径，否则使用会话 cwd；两者皆无的调用被拒绝。

## 场景文件

四个工具读写同一个文件：`<workspace>/.dsh/excalidraw/scene.json`（`SCENE_RELATIVE` 导出），即含 `elements` 数组与 `appState` 对象的 Excalidraw 场景对象。文件位于工作区的隐藏 `.dsh` 目录下，不在可见工作树中，且正是 web 画布标签页（`@reachforstar/dsh-client-ui-polish` 的 `/scene` 路由）渲染的同一文件——因此模型绘制会实时出现在白板上，画布编辑也是下次工具调用读到的内容。

场景是普通 JSON；工具实施以下边界：

| 边界 | 值 |
|---|---|
| `excalidraw_read` 完整 JSON 回显上限 | 128 KB |
| `excalidraw_write` 场景大小上限 | 1 MB |
| `excalidraw_draw` 每次调用元素数 | 256 |
| 导出路径逃逸 | 拒绝（`..`、前导 `/`、反斜杠） |

缺失场景读作空白画布；损坏（非 JSON）场景读作空白并带 `error` 字段，仅在解析时拒绝写入。

## 安全

场景与导出路径解析在调用工作区内：`excalidraw_export` 的 `path` 参数必须保持工作区相对（无 `..`、无前导 `/`、无反斜杠），场景文件本身始终是工作区相对的 `SCENE_RELATIVE`。工具使用 node 的 `fs/promises`，不涉及 shell，因此模型提供的路径永远不会逃出工作区或到达 shell。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包解析调用 agent 的 Workspace，校验场景与导出路径，并读写一份共享 JSON 场景文件。因此 Web 画布与面向模型的工具通过同一持久文件收敛，无需第二个同步 store。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web GUI 打磨](../../client/ui-polish/README.zh.md)——画布与场景路由。
- [Workspace 能力](../../workspace/workspace/README.zh.md)——Workspace 所有权与查找。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#reachforstardsh-tool-excalidraw)——精确工具 schema。

-----

<a id="model-experience"></a>
## 模型体验

### Tool schemas

#### What the model sees

模型看到生成的 [`excalidraw_read`、`excalidraw_write`、`excalidraw_draw`、`excalidraw_export` schemas](../../../docs/tool-catalog.zh.md#reachforstardsh-tool-excalidraw)：`excalidraw_read` 返回场景摘要（按类型统计的元素数、文本元素、主题）加完整场景 JSON（文件较小时）；`excalidraw_write` 用完整场景 JSON 字符串覆盖工作区场景；`excalidraw_draw` 用高层描述（`type`、位置、尺寸、可选的 text/points/样式）添加或替换形状，并填充 Excalidraw 渲染所需的全部字段，模型无需手写内部字段；`excalidraw_export` 将场景渲染为工作区内的 SVG 文件（纯 node 侧，无 canvas）。模型不会看到其未创作的 Excalidraw 内部元素字段；`excalidraw_draw` 只接受文档化的形状词汇并拒绝未知元素类型。

#### Token effect

每次调用：工具返回有界摘要（`excalidraw_read` 仅在 128 KB 上限内回显完整场景 JSON）与拒绝时的错误串；场景写入回显计数而非内容。不注册任何提示段。

#### KV Cache effect

无。工具不注册系统提示指引；schema 在每个部署内是静态的。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **平面矢量导出**——`excalidraw_export` 只还原平面填充/描边；roughjs 手绘纹理不在 node 侧渲染。
- **工作区要求**——无归属工作区 agent 会话的调用被拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作上下文——点击展开</summary>

无。

</details>
