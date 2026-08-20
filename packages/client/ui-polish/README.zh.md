# @deepseek-ai/dsh-client-ui-polish

[English](README.md) | 中文

Web GUI 打磨插件，浏览器半 + 小型 host 半——无需改动核心包即可获得的几项增强：

- **全局背景图片。** 插件拥有自己的 `ui-polish` settings 命名空间，将图片绘制到 body（`cover` / 固定 / 居中），并给 document 打上 `data-ds-bg-image` 标记。注入的全局样式表在属性存在时把基础 token（`--dsw-alias-bg-base`、`--dsw-specific-sidebar-fill`）覆盖为透明，使结构性表面——应用框架、会话区、详情区、侧边栏——让位于图片；需要对比度的内容元素（卡片、代码块、按钮）保留自身填充。General 设置行的上传（含大小/类型校验）、预览与移除由该行提供。图片以**磁盘文件**持久化（在 `/bg/current` 提供）——settings 文档只存短 URL，绝不存数兆 base64——重启后依然有效且不撑大设置文件。
- **会话统计费用浮层。** 一个 `conversation.composer.dock` 项以 `position: fixed` 钉在视口右上角，展示持久的 `sessionStats` 与 `tokenUsage` 投影数据（无前者的装配回退到窗口折叠），外加按模型计费的花费估算，输入/缓存/输出桶拆分直接显示在总额下方：一个仅状态的 Conversation Definition 将每条已结算助手消息的模型（messageId → model）记入插件自有索引，每步 usage 按其自身模型的费率与其自身结算时间计价（因此 deepseek 这类分时模型在高峰/低谷价间切换，按长度分档的模型选取覆盖输入长度的档位）。**费率卡**（每 100 万 token 人民币价）是内置 `src/client/model-pricing.json` 种子，由 amaxsmp 网关价格一次性换算而来；General 设置中的**模型费率卡**行以 JSON 编辑并持久化到 settings 文档，因此自定义卡重启后依然有效并立即重新计价。未知模型回退到卡的 `default` 项。
- **文件面板。** 一个 `conversation.view` 标签页（在轨迹与 Git 标签之间）浏览工作区仓库目录树：目录通过 `/git/list` 惰性展开，选择文件通过 `/git/read` 将当前内容读入可编辑 textarea；保存通过 `/git/write` 写回——文件就地编辑，绝不交给第三方应用。
- **Git 面板。** 一个 `conversation.view` 标签页（文件标签之后）展示浏览器当前查看的工作区仓库：分支、带逐文件 diff 的工作树变更、提交框（`add -A` + commit）、推送动作，以及双列布局的最近提交。选择变更文件在右列就地编辑（同一 `/git/read` + `/git/write`）。
- **Excalidraw 画布标签页。** 一个 `conversation.view` 标签页，在文档内直接嵌入 Excalidraw 白板（无 iframe）。画布通过 `/scene/current` 与 `/scene/write` 将场景文件持久化到 `<workspace>/.dsh/excalidraw/scene.json`——与 `@deepseek-ai/dsh-tool-excalidraw` 中模型面向的 `excalidraw_*` 工具读写的是同一文件，因此模型绘制的内容通过指纹轮询实时出现。Excalidraw 及其依赖内联进 client bundle（体积大）；react/react-dom 来自平台。
- **自动上下文压缩阈值。** General 设置行选择上下文压力比例（50–80%，未设置时用 80% 默认值），达到该比例时会话压缩后端自动压缩。选择持久化在 `ui-polish` settings 文档；node 半每步读取，低于默认值时在 `agent/pre-step` 测量压力，并请 agent 自身的压缩服务（经 roster 的 agent 寻址服务面）先压缩——绝不与内置 0.8 监听器重复压缩。

host 半在 host webserver 上注册 `/git`、`/bg`、`/scene` 路由前缀，按请求将每个 `cwd` 对照活动工作区注册表解析（切换工作区无需重启即可切换仓库），并通过 `execFile` 以数组参数运行 `git`（不经 shell）。包含 `..` 或分隔符的路径被拒绝，未知 cwd 回退到 host 进程 cwd，非仓库目录显示安静提示。

`/client` 导出为插件体（`apply`/`inject`）、组件 prop 类型与注入的背景写入面类型。

## Model Experience

无。本插件是纯客户端展示加 host HTTP 与 settings 管道，模型面向的白板工具位于 `@deepseek-ai/dsh-tool-excalidraw`。

#### KV Cache effect

无。

## Known Limitations and Deferred Work

- **固定定位浮层**——统计卡以 `position: fixed` 自钉（独立插件无法重排核心布局），因此无论 composer 自身位置如何都覆盖视口一角。
- **token 覆盖透明**——背景图激活时，所有绘制基础 token 的表面都变透明，包括部分读取 `--dsw-alias-bg-base` 的内容元素（如代码块），在复杂图片上可能降低对比度。
- **纯文本编辑**——文件与 Git 面板在等宽 textarea 中编辑，而非语法高亮编辑器。
- **背景上传上限**——图片上限 2MB（提供的是磁盘文件副本；settings 文档只保留 URL）。
- **包体积**——Excalidraw 画布标签页将白板库内联进 client bundle（未压缩约 12 MB），整个插件包较重；画布标签页是该体积的唯一消费者。
