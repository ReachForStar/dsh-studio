# remote/ — SSH/SFTP 能力族

[English](README.md) | 中文

能力族涵盖 SSH/SFTP 接缝（seam）定义、其本地 `ssh2` 实现、面向模型工具与 Web GUI 连接管理界面。全部为 **product** 包。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`ssh/`](ssh/README.zh.md) | 定义连接定义注册表契约（settings 支撑）、活动连接句柄与 exec/SFTP 词汇。 | `ctx.ssh` |
| [`ssh-local/`](ssh-local/README.zh.md) | 基于 `ssh2` 实现接缝：按定义共享连接、主机密钥校验、安全算法默认值与并行分片大文件传输。 | （注册 `ctx.ssh`） |
| [`tool-ssh/`](tool-ssh/README.zh.md) | 向模型暴露连接管理、远程命令执行与 SFTP 传输/浏览工具。 | （注册于 `ctx.tools`） |
| [`host/ssh-remotes`](../host/ssh-remotes/README.zh.md) | 浏览器侧 Host Remote 网关：定义增删查与连通性探测。 | `ctx.sshGateway`（wire 命名空间 `ssh`） |
| [`client/ui-ssh`](../client/ui-ssh/README.zh.md) | Web 设置页连接管理界面。 | （注册于 `settings.section`） |

base bundle 挂载 `ssh-local` + `tool-ssh`；Web 表面在此禁用工具行、改由 standard preset 按 agent 挂载，host 平面的 provider 与 GUI 网关对每个会话保持活动。

## 安全姿态

- 主机密钥默认校验（`accept-new`）：未知密钥首连记录、后续变更拒绝（`SSH_HOST_KEY_MISMATCH`）；定义可钉扎精确 `SHA256:<base64>` 指纹。`strictHostKey: reject` 直接拒绝未知密钥。
- 握手限定现代算法（无 CBC/arcfour 加密、无 SHA-1 MAC、无 `ssh-rsa` 主机密钥签名），除非 `allowLegacyAlgorithms` 为兼容老服务器退回 ssh2 默认。
- 认证机密存放在 harness 的 `ssh` settings 文档（与 shell 同等的信任），绝不跨越 wire 面；GUI 视其为只写。
- POSIX 私钥不得 group/other 可读（`strictPrivateKeyPermissions`）。
