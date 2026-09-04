---
description: "在 Web 设置中管理已保存的 SSH 连接，并打开支持密码或私钥认证的 SSH/SFTP 管理页。"
kind: "package-reference"
---

# @reachforstar/dsh-client-ui-ssh

[English](README.md) | 中文

## 概述

本包用于在 Web 设置中管理已保存的 SSH 连接。你可以创建、编辑、删除并测试密码或私钥定义，已保存的秘密不会被回显。本包提供连接管理；完整的交互式 PTY 和 SFTP 会话标签页由 `@reachforstar/dsh-client-ui-polish` 提供。

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

Web profile 需要已保存 SSH 连接定义的设置页时，挂载本浏览器插件。

### 何时选择

需要管理连接定义和执行连通性探测时选择本包；同一 Web profile 还需要交互式 PTY 和 SFTP 会话标签页时，再加入 `@reachforstar/dsh-client-ui-polish`。

### 最小配置

```yaml
- id: ui-ssh
  name: '@reachforstar/dsh-client-ui-ssh'
```

本包没有必填配置字段，需要 Web Remote 组合提供 `ssh` Remote 命名空间。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器插件拥有设置分区与快照 store。它把列出、保存、删除和测试操作委托给生成的 `ssh` Remote 命名空间；Host SSH 网关通过 `ctx.ssh` 解析已保存定义，并返回不含秘密的视图。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 能力](../../remote/ssh/README.zh.md)——与提供方无关的连接和 SFTP 契约。
- [本地 SSH 提供方](../../remote/ssh-local/README.zh.md)——Web profile 使用的 `ssh2` 实现。
- [Host SSH Remote 网关](../../host/ssh-remotes/README.zh.md)——面向浏览器的连接操作。
- [Web GUI 打磨](../ui-polish/README.zh.md)——交互式 PTY 和 SFTP 会话标签页。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只提供浏览器设置 UI，不注册面向模型的工具或 prompt 内容。

#### KV Cache effect

无。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

设置页管理连接定义，但不替代交互式终端包。

- **不展示主机密钥**——编辑器不显示已记住的主机指纹；探测结果和连接错误会携带相关结果。
- **没有私钥权限编辑器**——`strictPrivateKeyPermissions` 的失败会以连接错误呈现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作上下文——点击展开</summary>

无。

</details>
