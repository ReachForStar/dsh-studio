---
description: "为 agent 提供基于已配置 SSH 能力的连接、命令和 SFTP 工具。"
kind: "package-reference"
---

# @reachforstar/dsh-tool-ssh

[English](README.md) | 中文

## 概述

本包为 agent 提供保存和测试 SSH 连接、执行有界远程命令，以及读写远程 SFTP 文件的工具。SSH 秘密保留在 Host，并使用配置的 `ctx.ssh` 提供方。需要模型驱动远程操作且破坏性操作需要命令级控制时选择本包。

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

在 agent preset 中与 SSH 能力提供方一起挂载本工具消费方。

### 何时选择

agent 需要连接命名 SSH 服务器、执行前台命令或通过 SFTP 传输文件时选择本包。人类需要交互式终端时使用 Web SSH 面板。

### 最小配置

```yaml
- id: tool-ssh
  name: '@reachforstar/dsh-tool-ssh'
```

本包没有必填配置字段；精确的模型可见 schema 以生成的[工具目录](../../../docs/tool-catalog.zh.md#reachforstardsh-tool-ssh)为准。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

工具消费方解析调用方的 SSH 服务，通过服务注册表校验连接引用，并把命令和 SFTP 操作委托给活动连接句柄。本地传输路径由工具消费方解析，不改变 SSH 服务定义。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 能力](../ssh/README.zh.md)——与提供方无关的服务契约。
- [本地 SSH 提供方](../ssh-local/README.zh.md)——`ssh2` 实现。
- [Host SSH Remote 网关](../../host/ssh-remotes/README.zh.md)——浏览器传输。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#reachforstardsh-tool-ssh)——精确 schema。

-----

`ctx.ssh` 能力接缝的模型面 Consumer。工具：

- **连接管理**：`ssh_connect`（创建或更新定义）、`ssh_connections`（无秘密列表）、`ssh_disconnect`、`ssh_test`。
- **远程执行**：`ssh_exec`（有界输出与超时的前台命令）。
- **SFTP**：`sftp_list`、`sftp_stat`、`sftp_read`（下载）、`sftp_write`（上传）、`sftp_mkdir`、`sftp_rm`、`sftp_rename`。

本地传输路径相对会话工作区解析。连接按定义共享直至 `ssh_disconnect`；主机密钥默认校验、秘密绝不出现在结果中。`ssh_exec` 以终端卡片呈现，其余为通用卡片。

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型所见

十二个工具 schema（名称、必选/可选参数与描述）注册进 `ctx.tools` 并参与提示词装配，与其它工具一致；精确 schema 见生成的 [tool catalog](../../../docs/tool-catalog.zh.md)。`tool:ssh` 提示词段（`order: 106`）追加一行跨调用指引：

##### 该字段的逐字文本（如需）

```markdown
SSH/SFTP tools operate on saved connections: `ssh_connect` persists a definition before `ssh_exec`/`sftp_*` can use it, and connections stay open until `ssh_disconnect`. Verify remote commands before running destructive ones.
```

#### Token 影响

每次工具调用贡献其 JSON 参数到请求；不添加固定上下文块。

#### KV Cache effect

提示词段文本跨调用稳定，不使可复用前缀失效；工具 schema 按部署固定。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **无后台远程执行**：`ssh_exec` 仅前台（无 `run_in_background`）；长操作须适配 provider 超时。
- **`sftp_write` 不创建远程父目录**；先使用 `sftp_mkdir`（`recursive`）。
- **本地传输文件不受 sandbox 约束**：`sftp_read`/`sftp_write` 直接读写本地路径，位于 `ctx.fs` 策略世界之外。
- **主机密钥已校验但不向模型展示**：指纹变更呈现为 `SSH_HOST_KEY_MISMATCH`；清除需编辑 settings 文档。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作上下文——点击展开</summary>

无。

</details>
