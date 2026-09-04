---
description: "使用与提供方无关的 SSH 能力管理连接定义、执行命令并操作远程 SFTP 文件。"
kind: "package-reference"
---

# @reachforstar/dsh-ssh

[English](README.md) | 中文

## 概述

本包提供与提供方无关的 SSH 能力，管理连接定义、主机密钥记录、远程命令、PTY 会话和 SFTP 文件。选择 `@reachforstar/dsh-ssh-local` 等提供方实现网络连接，再由 `@reachforstar/dsh-tool-ssh` 或 Web SSH 面板消费。

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

组合需要保存连接或远程文件、命令能力时，与一个 SSH 提供方一起挂载本服务定义。

### 何时选择

消费方需要不依赖连接机制的稳定 SSH 服务时选择本包。使用 `@reachforstar/dsh-ssh-local` 提供本地 `ssh2` 连接，或提供其他实现。

### 最小配置

```yaml
- id: ssh
  name: '@reachforstar/dsh-ssh-local'
```

服务定义本身没有配置字段；提供方字段以所选提供方的配置目录为准。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

服务拥有持久化的连接定义和已记住的主机密钥。提供方在相同的 `ctx.ssh` 服务后实现连接建立、命令执行、PTY 会话和 SFTP 操作。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [本地 SSH 提供方](../ssh-local/README.zh.md)——本地 `ssh2` 实现。
- [SSH 工具](../tool-ssh/README.zh.md)——面向模型的消费方。
- [Host SSH Remote 网关](../../host/ssh-remotes/README.zh.md)——浏览器传输。
- [SSH Web 面板](../../client/ui-polish/README.zh.md)——浏览器消费方。

-----

`ctx.ssh` 能力接缝的 Service Definition：settings 支撑的连接定义注册表与 Provider 实现的连接契约。注册表（list/get/save/remove）、可组合的连通性探测、记住的主机密钥表与 exec/SFTP 词汇与 Provider 无关、由本包拥有；Provider 实现连接机制。

## 服务

每个 context 只挂载一个 Provider（二次注册抛错，cordis 标准重复服务行为）。服务要求 settings provider：定义与记住的主机密钥持久化在 `ssh` settings 命名空间（`dsh-settings-file` 下的 `$DSH_HOME/settings.yaml`，与 shell 访问同等的信任）。

```text
// registry (concrete)
ssh.list(): readonly SshConnectionDefinition[]
ssh.get(ref: SshConnectionId | string): SshConnectionDefinition | undefined
ssh.save(input: unknown): Promise<SshConnectionDefinition>   // id present = update, absent = create
ssh.remove(ref: SshConnectionId | string): Promise<boolean>
ssh.toView(definition): SshDefinitionView                    // secret-free wire view
ssh.resolve(ref): SshConnectionDefinition                    // id or unique name, throws SSH_NOT_FOUND
ssh.test(ref): Promise<SshTestResult>                        // open, probe, close; throws SSH_* on failure
ssh.knownHostFingerprint(hostPort: string): string | undefined
ssh.rememberHostKey(hostPort: string, fingerprint: string): Promise<void>

// connection contract (provider-owned)
ssh.connect(id): Promise<SshConnection>   // shared per definition id; close() evicts it
ssh.resolveExec(request): SshExecSpec     // provider defaults and caps
```

`SshConnection` 提供 `exec(spec)`（有界输出与自有超时的前台命令）与 `sftp`（list/stat/readFile/writeFile/mkdir/remove/rename）。定义可带可选 `hostKeyFingerprint`（`SHA256:<base64>`）钉扎服务器主机密钥以防中间人替换。

save 输入的 `id` 决定更新语义：连接必须存在；只写调用方（从未见过存储值的 wire/工具负载）省略的认证秘密从存储定义继承。名称全注册表唯一。

## 错误

带稳定 `code` 的类型化 `SshError`：`SSH_NOT_FOUND`、`SSH_NAME_EXISTS`、`SSH_INVALID_DEFINITION`、`SSH_CONNECT_FAILED`、`SSH_AUTH_FAILED`、`SSH_HOST_KEY_MISMATCH`、`SSH_HOST_KEY_UNKNOWN`、`SSH_CLOSED`、`SSH_EXEC_FAILED`、`SSH_SFTP_FAILED`、`SSH_LOCAL_IO`。

<a id="model-experience"></a>
## 模型体验

间接地，经由 @reachforstar/dsh-tool-ssh——它把接缝的定义、连接、exec 结果与 SFTP 操作呈现给模型。

#### KV Cache effect

无直接影响；模型面工具自行拥有其发出的请求 token。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **定义明文存储认证秘密**于 harness settings 文档（与 shell 访问同信任）；尚无 OS 钥匙串集成（`credentials` 接缝是未来归属）。
- **GUI 无法清除私钥口令**：只写更新可设置但不可清除口令（编辑 `settings.yaml` 移除）。
- `test` 探测会关闭其打开的共享连接；该定义的并发使用者在下一次调用时重连。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作上下文——点击展开</summary>

无。

</details>
