# Agent Note: SSH/SFTP 能力接缝

Status: implemented

[English](2026-08-22-ssh-sftp-capability-seam.md) | 中文

## Problem

harness 此前没有任何途径让 agent（或 Web GUI 中的人）操作远程服务器：没有已存连接定义、没有远程命令执行、也没有文件传输。Bash、文件系统与终端能力都止步于本地执行世界，因此针对远程主机的部署只能退回本地 `ssh` CLI 编排——无受管状态、无类型化结果、无 GUI 面。

## Decision

新增 `remote/` 包组，以标准三角色拆分交付 `ctx.ssh` 能力接缝：

- `@deepseek-ai/dsh-ssh`（Service Definition）拥有 settings 支撑的连接定义注册表（`ssh` settings 命名空间：定义 + 记住的主机密钥表）、活动连接契约与 exec/SFTP 词汇；同时拥有可组合的 `test` 探测与只写秘密更新语义（省略已存秘密的保存继承存储值）。
- `@deepseek-ai/dsh-ssh-local`（Service Provider）基于 `ssh2` 实现接缝：按定义 id 缓存一条连接、promise 包装的有界输出与自有超时 exec、完整 SFTP 操作面。主机密钥默认校验（`accept-new` 记住未知密钥、后续变更拒绝；`reject` 拒绝未知密钥；定义可钉扎 `SHA256:<base64>` 指纹）。握手限定现代算法，除非 `allowLegacyAlgorithms` 为老服务器退回 ssh2 默认。大文件传输在配置阈值以上走 ssh2 并行 `fastGet`/`fastPut`，并传入已知大小使 ssh2 跳过其 fstat（1.17 对 fstat 回调交付 NAME 数组，破坏 `fastXfer` 的单 attrs 假设）。
- `@deepseek-ai/dsh-tool-ssh`（Consumer）注册十二个模型面工具：`ssh_connect`、`ssh_connections`、`ssh_disconnect`、`ssh_test`、`ssh_exec` 与七个 `sftp_*` 传输/浏览工具。
- `@deepseek-ai/dsh-host-ssh-remotes` 以 Typert Remote 网关服务 Web GUI（`ctx.sshGateway`，wire 命名空间 `ssh`）：定义增删查与连通性探测，全部无秘密。
- `@deepseek-ai/dsh-client-ui-ssh` 在该网关之上渲染设置页。

组合：base bundle 挂载 provider 与工具；Web 表面禁用 `tool-ssh`、由 standard preset 按 agent 挂载，host 平面的 provider 与网关对每个会话保持活动。`ssh` settings 命名空间由 Service Definition 注册，providers、工具、网关与 GUI 共享同一份定义存储。

## Security posture

认证秘密存于 harness settings 文档（与 shell 同等的信任）且绝不跨越 wire 面；GUI 与网关视其为只写。主机密钥校验闭合了 ssh2 默认留下的中间人缺口；现代算法默认排除 CBC/arcfour 加密、SHA-1 MAC 与 `ssh-rsa` 主机密钥签名。POSIX 私钥不得 group/other 可读。

## Alternatives considered

- **薄封装本地 `ssh` CLI**：拒绝——无类型化结果、无受管状态、无进程内 SFTP 面，且平台 shell 怪癖（Windows）会泄漏进接缝。
- **复用 `credentials` 接缝存秘密**：推迟——凭据/授权机制面向 env 引用的 API 密钥；SSH 定义是秘密与非秘密字段混合的单文档。settings 文档以文档化的 shell 同等信任承载，credentials 接缝仍是未来归属。
- **整个族打包为一个包**：拒绝——角色独立演进（未来远程 provider 或 TUI 消费方会拖带 GUI 网关与工具）；shell 三人组是模板。
- **不做主机密钥校验（无 TOFU）**：拒绝——静默接受 MITM 是该接缝不应交付的安全回退；`accept-new` 保留首连易用性同时捕捉后续替换。
- **手写 SFTP 并行传输替代 `fastGet`/`fastPut`**：拒绝——内置并行路径删除真实代码；`fileSize` 选项绕开 fstat 怪癖。

## Consequences

harness 获得完整的远程执行能力：类型化结果、持久定义、主机密钥校验与 GUI 面，与产品其余部分的接缝惯例一致。代价：秘密明文位于 settings 文档（已文档化）、`ssh_exec` 仅前台、远程 `cwd` 前缀假设 POSIX shell、本地传输路径位于 `ctx.fs` 策略世界之外。测试通过真实进程内 `ssh2` 服务器（密码与公钥认证、exec、完整 SFTP 面、主机密钥接受/拒绝/钉扎、算法默认与并行传输）覆盖接缝，另含 Loader 组合测试与真实 WSL sshd 冒烟。

## Testing

单测与真实组合套件按包位于 `packages/remote/*/tests`；provider 套件启动真实 `ssh2` 服务器（最小 SFTP 子系统映射临时目录），工具套件经 Loader 组合驱动受管执行器。GUI 包在 `packages/client/ui-ssh/tests` 拥有 store/组件/host/invariant 套件（`test:gui`）。
