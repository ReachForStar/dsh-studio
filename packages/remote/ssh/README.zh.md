# @deepseek-ai/dsh-ssh

[English](README.md) | 中文

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

## Model Experience

间接地，经由 @deepseek-ai/dsh-tool-ssh——它把接缝的定义、连接、exec 结果与 SFTP 操作呈现给模型。

#### KV Cache effect

无直接影响；模型面工具自行拥有其发出的请求 token。

## 已知限制与待办

- **定义明文存储认证秘密**于 harness settings 文档（与 shell 访问同信任）；尚无 OS 钥匙串集成（`credentials` 接缝是未来归属）。
- **GUI 无法清除私钥口令**：只写更新可设置但不可清除口令（编辑 `settings.yaml` 移除）。
- `test` 探测会关闭其打开的共享连接；该定义的并发使用者在下一次调用时重连。
