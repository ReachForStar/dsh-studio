---
description: "配置面向浏览器的 SSH/SFTP 连接管理、远程命令、PTY 会话和文件传输 Host Remote 网关。"
kind: "package-reference"
---

# @reachforstar/dsh-host-ssh-remotes

[English](README.md) | 中文

## 概述

本包向 Web 客户端提供 SSH 连接管理、远程命令、交互式 PTY 会话和 SFTP 文件传输。网关把连接秘密保留在 Host，只返回不含秘密的连接视图。它需要 `ctx.ssh` 提供方和 Host Connection 传输。

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

在 Web Host 组合中与 SSH 提供方、Connection 传输和客户端 Remote 组合一起挂载本网关。

### 何时选择

浏览器需要通过认证 Host API 执行完整 SSH/SFTP 操作时选择本包。使用 `@reachforstar/dsh-client-ui-ssh` 提供连接设置，使用 `@reachforstar/dsh-client-ui-polish` 提供交互式会话标签页。

### 最小配置

```yaml
- id: ssh-remotes
  name: '@reachforstar/dsh-host-ssh-remotes'
```

本包没有独立配置字段，完整组合字段以生成的[配置目录](../../../docs/config-catalog.zh.md)为准。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

网关通过 `ctx.ssh` 解析每个已保存定义。JSON Remote 方法处理命令、PTY 控制和 SFTP 元数据；认证后的 Fetch 路由传输文件内容；PTY 输出和结束状态使用应用 Remote Event 通道。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 能力](../../remote/ssh/README.zh.md)——与提供方无关的连接和 SFTP 契约。
- [本地 SSH 提供方](../../remote/ssh-local/README.zh.md)——`ssh2` 实现。
- [浏览器 SSH 设置](../../client/ui-ssh/README.zh.md)——连接编辑器。
- [Web SSH/SFTP 面板](../../client/ui-polish/README.zh.md)——交互式终端和文件管理器。

-----

<a id="model-experience"></a>
## 模型体验

无——本包仅服务浏览器。

#### KV Cache effect

无直接影响；浏览器调用发生在模型请求之外。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **列表无推送刷新**：浏览器每次变更后重取；`ssh` 段的外部 `settings.yaml` 编辑需要刷新页面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作上下文——点击展开</summary>

无。

</details>
