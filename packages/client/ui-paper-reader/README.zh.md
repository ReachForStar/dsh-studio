---
description: "右侧栏论文阅读器：按原始排版显示上传的 PDF，支持文字高亮与笔记，并可把提问填入会话草稿。"
kind: "package-reference"
---

# @reachforstar/dsh-client-ui-paper-reader

[English](README.md) | 中文

## 概述

本包在右侧栏标签页里阅读上传的论文。浏览器半列出已存储的论文库，用 PDF.js 把每页渲染到 canvas 并叠加可选中文字层，选中文字后弹出悬浮菜单，提供高亮、添加笔记、在会话中提问三项操作。Host 半把 PDF 与注释存到 web profile 目录，并通过 `/paper-reader` 提供读取。本包只注册一个标签类型，不读取 Sidebar 的任何 store。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 Host 可写入 profile 目录的 Web 组合里挂载它。标签出现在右侧栏引导页；打开后列出已上传的论文，上传 PDF 后立即打开阅读。

### 最小配置

```yaml
- id: ui-paper-reader
  name: '@reachforstar/dsh-client-ui-paper-reader'
```

浏览器半需要 `slots`、`locale`、`sidebarRightTabs`、`sessions`、`conversation` 五个服务；Host 半需要 `webServer`。论文与注释文档存放在 `~/.dsh/profiles/web/papers/`，文件名分别为 `<id>.pdf` 与 `<id>.json`。

<a id="model-experience"></a>
## 模型体验

无——提问操作只把内容填入未发送的会话草稿，不提交。

#### KV Cache effect

无直接影响；草稿只有在用户提交时才进入模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 高亮保存的是取自浏览器选区框的页面相对矩形，因此跨页的选区不会弹出菜单。
- 阅读器没有搜索、目录或跳页控件；它在一条滚动列里绘制全部页面，页面接近视口时才光栅化。
- 上传不做合并：同一文件上传两次会得到两个论文条目，删除条目会同时删除它的注释。
- 注释文档每次改动都整体重写，因此两个浏览器标签同时编辑同一篇论文时，后写入的列表会覆盖前一个。
