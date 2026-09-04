---
description: "配置 Web GUI 背景、自动压缩阈值、模型费率卡、工作区工具与 SSH/SFTP 终端功能。"
kind: "package-reference"
---

# @reachforstar/dsh-client-ui-polish

[English](README.md) | 中文

## 概述

本包用于配置 Web GUI 背景、自动上下文压缩阈值和模型费率卡，也提供工作区文件、Git、Excalidraw 及 SSH/SFTP 标签页，无需修改 agent loop。需要这些产品控制项的 Web profile 应挂载本包；本包内置 Excalidraw 和 xterm.js，因此会增加客户端包体积。

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

需要可配置展示、工作区编辑或 SSH/SFTP 访问时，将本包挂载到 Web 浏览器 roster。

### 何时选择

本包适合需要背景定制、模型费用展示、工作区文件操作或完整 SSH/SFTP 终端的本地 Web profile。不应在 headless profile 中挂载，因为其浏览器 slot 和 host HTTP 路由依赖 Web 组合。

### 最小配置

```yaml
- id: ui-polish
  name: '@reachforstar/dsh-client-ui-polish'
```

本包没有必填组合配置字段；用户设置从 Web UI 编辑。完整的组合字段以生成的[配置目录](../../../docs/config-catalog.zh.md)为准。

-----

## 功能

Web GUI 打磨插件，浏览器半 + 小型 host 半——无需改动核心包即可获得的几项增强：

- **全局背景图片。** 插件拥有自己的 `ui-polish` settings 命名空间，将图片绘制到 body（`cover` / 固定 / 居中），并给 document 打上 `data-ds-bg-image` 标记。注入的全局样式表在属性存在时把基础 token（`--dsw-alias-bg-base`、`--dsw-specific-sidebar-fill`）覆盖为透明，使结构性表面——应用框架、会话区、详情区、侧边栏——让位于图片；需要对比度的内容元素（卡片、代码块、按钮）保留自身填充。General 设置行的上传（含大小/类型校验）、预览与移除由该行提供。图片以**磁盘文件**持久化（在 `/bg/current` 提供）——settings 文档只存短 URL，绝不存数兆 base64——重启后依然有效且不撑大设置文件。
- **会话统计费用浮层。** 一个 `conversation.composer.dock` 项以 `position: fixed` 钉在视口右上角，展示持久的 `sessionStats` 与 `tokenUsage` 投影数据（无前者的装配回退到窗口折叠），外加按模型计费的花费估算，输入/缓存/输出桶拆分直接显示在总额下方：一个仅状态的 Conversation Definition 将每条已结算助手消息的模型（messageId → model）记入插件自有索引，每步 usage 按其自身模型的费率与其自身结算时间计价（因此 deepseek 这类分时模型在高峰/低谷价间切换，按长度分档的模型选取覆盖输入长度的档位）。**费率卡**（每 100 万 token 人民币价）是内置 `src/client/model-pricing.json` 种子，由 amaxsmp 网关价格一次性换算而来；General 设置中的**模型费率卡**行以 JSON 编辑并持久化到 settings 文档，因此自定义卡重启后依然有效并立即重新计价。未知模型回退到卡的 `default` 项。
- **文件面板。** 一个 `conversation.view` 标签页（在轨迹与 Git 标签之间）浏览工作区仓库目录树：目录通过 `/git/list` 惰性展开，选择文件通过 `/git/read` 将当前内容读入可编辑 textarea；保存通过 `/git/write` 写回——文件就地编辑，绝不交给第三方应用。
- **SSH/SFTP 面板。** 一个 `conversation.view` 标签页，提供已保存连接选择、远程命令探测、交互式 PTY 与 SFTP 目录/文件操作。控制操作使用生成的 `ssh` Remote 命名空间；PTY 输出与退出使用共享 Remote Event 流；文件传输使用经过认证的 Host Fetch 路由。
- **Git 面板。** 一个 `conversation.view` 标签页（文件标签之后）展示浏览器当前查看的工作区仓库：分支、带逐文件 diff 的工作树变更、提交框（`add -A` + commit）、推送动作，以及双列布局的最近提交。选择变更文件在右列就地编辑（同一 `/git/read` + `/git/write`）。
- **Excalidraw 画布标签页。** 一个 `conversation.view` 标签页，在文档内直接嵌入 Excalidraw 白板（无 iframe）。画布通过 `/scene/current` 与 `/scene/write` 将场景文件持久化到 `<workspace>/.dsh/excalidraw/scene.json`——与 `@reachforstar/dsh-tool-excalidraw` 中模型面向的 `excalidraw_*` 工具读写的是同一文件，因此模型绘制的内容通过指纹轮询实时出现。Excalidraw 及其依赖内联进 client bundle（体积大）；react/react-dom 来自平台。
- **自动上下文压缩阈值。** General 设置行选择上下文压力比例（50–80%，未设置时用 80% 默认值），达到该比例时会话压缩后端自动压缩。选择持久化在 `ui-polish` settings 文档；node 半每步读取，低于默认值时在 `agent/pre-step` 测量压力，并请 agent 自身的压缩服务（经 roster 的 agent 寻址服务面）先压缩——绝不与内置 0.8 监听器重复压缩。

host 半在 host webserver 上注册 `/git`、`/bg`、`/scene` 路由前缀，按请求将每个 `cwd` 对照活动工作区注册表解析（切换工作区无需重启即可切换仓库），并通过 `execFile` 以数组参数运行 `git`（不经 shell）。包含 `..` 或分隔符的路径被拒绝，未知 cwd 回退到 host 进程 cwd，非仓库目录显示安静提示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器半注册独立的设置行与会话 slot；host 半拥有背景、工作区、Git、Excalidraw 和 SSH/SFTP 路由。设置值通过 `settingsScope` 传递；SSH 控制调用使用生成的 `ssh` Remote 命名空间，PTY 事件使用共享 Remote Event 流，文件传输使用认证后的 Fetch 路由。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 应用 bundle](../../bundle/web-app/README.zh.md)——发布的 Web 组合。
- [SSH 能力](../../remote/ssh/README.zh.md)——与提供方无关的 SSH 连接和 SFTP 契约。
- [Host SSH Remote 网关](../../host/ssh-remotes/README.zh.md)——面向浏览器的 SSH 方法与路由。
- [配置目录](../../../docs/config-catalog.zh.md)——完整的组合字段。

-----

## 安装

像内置 client 插件一样，把本插件作为 web-app bundle（`cordis.patch.yml`）中的 browser-roster 行挂载；内置 `dsh-web-app` patch 已包含该行：

```yaml ignore-check
- id: ui-polish
  name: '@reachforstar/dsh-client-ui-polish'
```

模型面向的白板工具（`excalidraw_read`/`write`/`draw`/`export`）位于独立的 [`@reachforstar/dsh-tool-excalidraw`](../../fs/tool-excalidraw/README.zh.md) 包中，通过 agent-preset 行挂载（内置 `standard` preset 已包含该行）：

```yaml ignore-check
- id: tool-excalidraw
  name: '@reachforstar/dsh-tool-excalidraw'
```

node 半通过 `ctx.inject` 等待可选的 `settings` 与 `webServer` 服务，因此在缺少它们的组合中插件也能无害加载。

## 设置

插件拥有用户设置文档中的 `ui-polish` 命名空间（由 `PolishSettingsSchema` 校验）：

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `backgroundImage` | `string`（URL） | 缺省 | 已服务的背景图（`/bg/current`）或旧式 data URL；缺省即清除背景。 |
| `compactionThresholdRatio` | `number`（0.5–0.8） | 缺省（harness 0.8） | node 半请求会话压缩服务压缩时的压力比例。 |
| `modelPricing` | `string`（JSON） | 缺省（内置种子卡） | 为统计浮层计价的用户编辑费率卡；见下节“模型费率卡”。 |

背景图与压缩阈值字段来自原独立插件；费率卡是整合包的扩展（见下一节）。

## 模型费率卡

统计浮层按每条已结算助手消息自身模型的费率与结算时间，对照费率卡（每 100 万 token 人民币价）计价。内置卡位于 `src/client/model-pricing.json`，由 amaxsmp 网关价格快照换算而来；General 设置中的**模型费率卡**行以 JSON（`{ default, models }`）编辑并持久化到 `modelPricing`。保存的卡重启后依然有效并立即重新计价；非法 JSON 或非有限价格会以字段级消息被拒绝，不持久化任何内容。未知模型回退到卡的 `default` 项；分时模型（deepseek）在高峰/低谷边界切换，按长度分档的模型选取覆盖计费输入的档位。

## Host 路由

node 半在 host webserver 上注册三个前缀；每个请求都携带工作区 `cwd`（GET 在 query、POST 在 JSON body），按请求对照活动工作区注册表解析：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/git/list` | POST `{cwd, dir?}` | 目录项（文件 + 子目录），目录在前；`dir` 为仓库相对路径。 |
| `/git/read` | POST `{cwd, path}` | 文件内容（图片预览返回 data URL）。 |
| `/git/write` | POST `{cwd, path, content}` | 就地覆盖文件。 |
| `/git/status` | GET `?cwd` | 分支 + porcelain 工作树状态。 |
| `/git/diff` | GET `?cwd&path` | 单文件工作树 diff。 |
| `/git/log` | GET `?cwd` | 最近提交主题。 |
| `/git/commit` | POST `{cwd, message}` | `add -A` + 提交。 |
| `/git/push` | POST `{cwd}` | 推送当前分支。 |
| `/bg/current` | GET | 已持久化的背景图文件。 |
| `/bg/upload` | POST（原始 body） | 上传背景图（≤ 2MB）；返回 `{url}`。 |
| `/bg` | DELETE | 尽力删除已持久化的文件。 |
| `/scene/current` | POST `{cwd}` | 工作区 Excalidraw 场景 JSON，无场景时 404。 |
| `/scene/write` | POST `{cwd, scene}` | 覆盖工作区场景文件（校验 JSON）。 |

`git` 通过 `execFile` 以数组参数运行——不经 shell，因此路径与提交信息永不进入 shell。包含 `..` 或路径分隔符的路径被拒绝，未知 `cwd` 回退到 host 进程目录（浏览器标签页随后显示非仓库提示）。

## Slots

浏览器半注册进五个 slot：

| Slot | id | 用途 |
|---|---|---|
| `settings.general.item` | `polish-background` | 背景图上传 / 预览 / 移除。 |
| `settings.general.item` | `polish-compaction` | 自动压缩阈值选择。 |
| `settings.general.item` | `polish-pricing` | 模型费率卡 JSON 编辑器。 |
| `conversation.composer.dock` | `polish-stats` | 会话统计费用浮层（钉在视口）。 |
| `conversation.view` | `files` | 工作区文件浏览 / 编辑。 |
| `conversation.view` | `git` | Git 面板（状态、diff、提交、推送、日志）。 |
| `conversation.view` | `excalidraw` | Excalidraw 白板标签页。 |
| `conversation.view` | `ssh` | SSH/SFTP PTY 面板。 |

<a id="model-experience"></a>
## 模型体验

无。本插件是纯客户端展示加 host HTTP 与 settings 管道，模型面向的白板工具位于 `@reachforstar/dsh-tool-excalidraw`。

#### KV Cache effect

无。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **固定定位浮层**——统计卡以 `position: fixed` 自钉（独立插件无法重排核心布局），因此无论 composer 自身位置如何都覆盖视口一角。
- **token 覆盖透明**——背景图激活时，所有绘制基础 token 的表面都变透明，包括部分读取 `--dsw-alias-bg-base` 的内容元素（如代码块），在复杂图片上可能降低对比度。
- **纯文本编辑**——文件与 Git 面板在等宽 textarea 中编辑，而非语法高亮编辑器。
- **背景上传上限**——图片上限 2MB（提供的是磁盘文件副本；settings 文档只保留 URL）。
- **包体积**——Excalidraw 画布标签页将白板库内联进 client bundle（未压缩约 12 MB），整个插件包较重；画布标签页是该体积的唯一消费者。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作上下文——点击展开</summary>

无。

</details>
