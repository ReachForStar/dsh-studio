---
description: "右侧栏论文阅读器：按原始排版显示上传的 PDF，支持文字高亮与笔记，并可把提问填入会话草稿。"
kind: "package-reference"
---

# @reachforstar/dsh-client-ui-paper-reader

[English](README.md) | 中文

## 概述

本包在右侧栏标签页里阅读上传的论文。浏览器半列出已存储的论文库，用 PDF.js 把每页渲染到 canvas 并叠加可选中文字层，选中文字后弹出悬浮菜单，提供高亮、添加笔记、在会话中提问、翻译四项操作。选中文字或整篇文档都可以译为中文或英文，结果流式进入可关闭、可复制的卡片。Host 半把 PDF 与注释存到 web profile 目录，通过 `/paper-reader` 提供读取，并通过 `/paper-reader/translate` 流式返回译文片段。本包只注册一个标签类型，不读取 Sidebar 的任何 store。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Host 可写入 profile 目录的 Web 组合里挂载它。标签出现在右侧栏引导页；打开后列出已上传的论文，上传 PDF 后立即打开阅读。

### 最小配置

```yaml
- id: ui-paper-reader
  name: '@reachforstar/dsh-client-ui-paper-reader'
```

浏览器半需要 `slots`、`locale`、`sidebarRightTabs`、`sessions`、`conversation` 五个服务；Host 半需要 `webServer`，翻译路由还额外等待 `llm`。论文与注释文档存放在 `~/.dsh/profiles/web/papers/`，文件名分别为 `<id>.pdf` 与 `<id>.json`。

### 翻译

选中翻译提交所选文字；工具条的全文翻译用 PDF.js 提取每页文字，跳过没有文字的页，再按顺序提交其余页面。两者都按每次提交发出一个温度为零的请求，走第一条产出文字的 LLM 路由；目标语言在界面语言为中文时默认为中文，其余情况默认为英文，卡片可在两者间切换。路由以 NDJSON 应答——先是 `delta` 行，最后是 `finish`；首个片段之前的失败是 JSON 错误响应，之后则是 `error` 行。翻译内容不进入会话日志。

<a id="model-experience"></a>
## 模型体验

无——提问操作只把内容填入未发送的会话草稿，翻译请求则把答复流式送入阅读器卡片，两者都不贡献会话上下文，也不产生日志消息。

#### KV Cache effect

翻译请求在同一目标语言下重复同一段固定的短系统提示词，提供方可复用该前缀；其后的页面或选区文字逐次不同。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 高亮保存的是取自浏览器选区框的页面相对矩形，因此跨页的选区不会弹出菜单。
- 阅读器没有搜索、目录或跳页控件；它在一条滚动列里绘制全部页面，页面接近视口时才光栅化。
- 上传不做合并：同一文件上传两次会得到两个论文条目，删除条目会同时删除它的注释。
- 注释文档每次改动都整体重写，因此两个浏览器标签同时编辑同一篇论文时，后写入的列表会覆盖前一个。
- 翻译需要已组合的 `llm` 服务；缺少它时论文库仍可读取，但翻译路由不会注册。
- 全文翻译为每个有文字的页面发出一次请求，长论文因此会产生多次模型调用。
- 翻译目标只提供中文与英文；其他界面语言默认从英文开始。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作上下文——点击展开</summary>

无。

</details>
