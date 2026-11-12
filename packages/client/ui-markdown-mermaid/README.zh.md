---
description: "dsh Web 客户端中的聊天 Mermaid 围栏：回复落定后绘制图表，流式输出或绘制失败时显示源码，以及该层实际使用的绘制流程。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-markdown-mermaid

[English](README.md) | 中文

## 概述

带 `mermaid` 代码围栏的聊天回复可以用图表代替源码显示。围栏所在回复落定后，图表画在代码块的位置；回复仍在流式输出、或 Mermaid 拒绝该图表正文时，保留源码块，回复照常可读。绘制完全在浏览器内完成，使用的是本包按需加载的 Mermaid 分块：不调用 Host，也不改动模型的回复。与 `ui-chat` 一起挂载即可启用；未挂载时每个围栏都按代码块显示。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在与 `ui-chat` 相同的组合中挂载本插件；聊天中的 Markdown 围栏此后按语言分发到本包，其余语言继续显示代码块。本插件没有配置项，也没有命令。

### 读者看到的行为

所在回复已落定的 `mermaid` 围栏会画成图表，居中排在消息列内，宽于消息列时横向滚动。回复流式输出期间，同一围栏保持代码块，写了一半的图表不会画成语法错误；围栏落定后才出现图表。Mermaid 拒绝的正文重新显示代码块，并附一条无法绘制的提示，源码因此始终可读。其他语言的围栏不受影响：本包只占用围栏槽位的 `mermaid` 语言。

### 何时选择本包

只要 Web 端聊天需要显示图表就应挂载；如果希望所有围栏都保持源码，例如在永远不加载 Mermaid 分块的组合里，可以省略。没有按会话或按回复的开关：是否绘制由围栏语言和回复是否落定决定。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

浏览器半区以一个层注册进聊天所有、`key` 为 `mermaid` 的 `conversation.chat.markdown.fence` HOC 槽位，因此聊天的 `entryKey` 分发只对 `mermaid` 围栏选中它，其他语言则渲染 owner 提供的普通代码块。`apply` 为每个插件实例创建一个渲染器和一个 id 序列，并通过槽位的注入面交给该层；该层因此从不接触模块级的库句柄。

`streaming` 为真时，该层直接渲染 owner 的 `FenceCodeBlock`；否则把它作为绘制的回退内容传下去。一个绘制组件持有三种状态——绘制中、已绘制、失败——每种都带上它描述的那段围栏正文；渲染阶段的派生状态重置会丢弃正文已变化的旧结果，副作用清理会在组件卸载时放弃绘制，渲染器收到的是按每次绘制生成的 `mermaid-diagram-<n>` id。

渲染器在第一个落定围栏处通过动态 `import()` 加载 `mermaid`，库因此位于 `lib/client.*.js` 分块中，浏览器按需获取，而不是在聊天启动时获取。首次加载只初始化一次，参数为 `startOnLoad: false`、`securityLevel: 'strict'` 与 `suppressErrorRendering: true`；严格模式在 mermaid 对序列化 SVG 消毒之前编码内嵌 HTML 并去掉点击处理器，抑制错误绘制让非法正文抛出而不是画出 mermaid 自己的错误图，这正是进入代码块回退的路径。返回的 SVG 按 mermaid 的渲染约定作为标记插入。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只绘制模型已经写出的围栏正文；它不注册任何进入模型请求的提示、工具或结果。

#### KV 缓存影响

无；绘制属于浏览器呈现，模型可见历史及其已缓存的公共前缀保持不变。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **使用 Mermaid 主题而非应用主题** — 图表颜色来自 mermaid 的默认主题，因此深色页面中的图表按浅色绘制。要让图表配色跟随 `--dsw-*` 变量，需要在每次主题切换时重新初始化该库。
- **没有平移、缩放或全屏** — 宽于消息列的图表只能横向滚动；没有独立查看器，大图按绘制尺寸阅读。
- **首张图承担库的加载代价** — Mermaid 分块在第一个落定围栏处才加载，因此这张图可能晚于回复正文出现；之后的图表复用同一次加载。
- **每个产物都有一份私有副本** — 另一个内嵌 Mermaid 的包（例如 Excalidraw 面板）自带副本，两者不共享模块表条目。
- **只识别 `mermaid` 语言** — `mmd` 之类的别名仍是代码块，因为槽位分发键就是围栏语言词本身。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无；该层唯一的隐藏状态是注入的渲染器与 id 序列，两者都由 `apply` 创建并持有。

</details>
