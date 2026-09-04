---
description: "配置基于 ssh2 的本地提供方，支持有界 SSH 命令、交互式 PTY 会话和 SFTP 传输。"
kind: "package-reference"
---

# @reachforstar/dsh-ssh-local

[English](README.md) | 中文

## 概述

本包通过本地 `ssh2` 客户端提供 `ctx.ssh` 能力。它按定义复用连接，支持有界命令执行、交互式 PTY 会话、主机密钥校验和 SFTP 传输。Host 进程需要能直接访问目标 SSH 服务器。

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

Host 进程拥有 SSH 网络连接时，与 `@reachforstar/dsh-ssh` 一起挂载本提供方。

### 何时选择

需要从 Node 直接访问 SSH/SFTP 时选择本提供方。只有在目标服务器不支持安全默认算法时，才设置 `allowLegacyAlgorithms: true`。

### 最小配置

```yaml
- id: ssh
  name: '@reachforstar/dsh-ssh-local'
```

本提供方的可选字段记录在下方配置章节和生成的[配置目录](../../../docs/config-catalog.zh.md)中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本提供方按已保存定义保留一个活动连接，连接断开后移除它。命令输出按流限制大小，PTY 会话提供输出和结束回调，SFTP 传输根据配置的文件大小阈值选择顺序或并行路径。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 能力](../ssh/README.zh.md)——与提供方无关的服务定义。
- [SSH 工具](../tool-ssh/README.zh.md)——面向模型的消费方。
- [Host SSH Remote 网关](../../host/ssh-remotes/README.zh.md)——浏览器传输。

-----

基于 [`ssh2`](https://www.npmjs.com/package/ssh2) 的 `ctx.ssh` 接缝本地 Service Provider。按定义 id 缓存并复用一条连接，直至关闭或断开；exec 与 SFTP 操作经 promise 包装，输出有界、自有超时会杀掉远程命令。

## 配置

```yaml
- id: ssh
  name: '@reachforstar/dsh-ssh-local'
  config:
    defaultExecTimeoutMs: 60000       # default foreground command timeout
    maxExecTimeoutMs: 600000          # cap for per-call overrides
    outputMaxBytes: 65536             # per-stream capture cap; overflow keeps the tail
    strictHostKey: accept-new         # accept-new | reject
    allowLegacyAlgorithms: false      # true = ssh2 defaults (old servers)
    keepaliveIntervalMs: 0            # SSH keep-alive interval (0 disables)
    strictPrivateKeyPermissions: true # reject group/other-readable POSIX keys
    fastTransferThresholdBytes: 1048576  # transfers above this use parallel fastGet/fastPut (0 disables)
```

## 行为

- **主机密钥校验**：`accept-new`（默认）首连把未知密钥记入 `ssh` settings 命名空间、后续变更拒绝；`reject` 直接拒绝未知密钥。定义上的 `hostKeyFingerprint` 钉扎优先于记住表。拒绝以 `SSH_HOST_KEY_MISMATCH` / `SSH_HOST_KEY_UNKNOWN` 呈现。
- **现代算法默认**：握手限定 curve25519/nistp ECDH kex、GCM/CTR 加密、SHA-2 MAC、ed25519/ecdsa/rsa-sha2 主机密钥。老服务器需 `allowLegacyAlgorithms: true`。
- **有界 exec**：每流输出上限保留尾部（标记截断）；自有 deadline 通过信号杀掉远程命令并报告 `timedOut`；调用方取消报告 `aborted`。
- **并行大文件传输**：超过 `fastTransferThresholdBytes` 的文件走 ssh2 `fastGet`/`fastPut`（并发分片读写）；小文件顺序流式传输且覆盖语义精确。快速下载传入已知大小，使 ssh2 跳过其 fstat（1.17 对 fstat 回调交付 NAME 数组，破坏其单 attrs 假设）。
- **共享连接**：`connect` 返回缓存句柄；服务器断连自逐出，下次 `connect` 新建。组合 teardown 关闭全部池化连接。

<a id="model-experience"></a>
## 模型体验

间接地，经由 @reachforstar/dsh-tool-ssh——它把接缝的连接、exec 结果与 SFTP 操作呈现给模型。

#### KV Cache effect

无直接影响；模型面工具自行拥有其发出的请求 token。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **`ssh_exec` 的 `cwd` 前缀假设 POSIX 远程 shell**（单引号 `cd`）；Windows cmd 远程主机无法满足。
- **尚无主机密钥轮换 UX**：密钥变更以 `SSH_HOST_KEY_MISMATCH` 失败；清除记住条目需编辑 `ssh` settings 段。
- **无后台远程命令**：`ssh_exec` 仅前台；长操作须适配超时。
- **无 known_hosts 文件互操作**：记住表存于 settings，而非 `~/.ssh/known_hosts`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作上下文——点击展开</summary>

无。

</details>
