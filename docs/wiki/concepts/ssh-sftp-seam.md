---
title: SSH/SFTP 能力接缝（ctx.sshSftp）
type: concept
tags: [ssh, sftp, capability-seam, fork, cordis, 远端工作区]
created: 2026-09-17
updated: 2026-09-18
sources: []
status: active
---

# SSH/SFTP 能力接缝（ctx.sshSftp）

## 定义

fork 自研的远程执行与文件传输接缝：Service Definition 声明连接定义注册表（settings 支撑）、活动连接句柄与 exec/SFTP 词汇；Service Provider 用 `ssh2` 实现；Consumer 是面向模型的工具与 Host Remote 网关。

## 在本项目中的具体含义

| 角色 | 包 | ctx 键 |
| --- | --- | --- |
| Service Definition | `packages/remote/ssh`（`@reachforstar/dsh-ssh`） | `ctx.sshSftp` |
| Service Provider | `packages/remote/ssh-local`（`ssh2`） | 注册到该接缝 |
| Consumer（模型工具） | `packages/remote/tool-ssh` | 注册于 `ctx.tools` |
| Consumer（Host 网关） | `packages/host/ssh-remotes` | `ctx.sshSftpGateway`（wire 命名空间 `ssh`） |
| Consumer（浏览器 UI） | `packages/client/ui-ssh` | 注册于 `settings.section` |
| Provider（远端工作区，fork 自研） | `packages/remote/fs-sftp`、`packages/remote/subprocess-sftp` | 注册 `ctx.fs` / `ctx.subprocess`（详见[远端工作区 provider](../entities/remote-workspace-providers.md)） |

保持不变的名字（重命名时刻意未动）：settings 命名空间 `ssh`、Remote 命名空间 `ssh`、事件 `ssh/pty/output` 与 `ssh/pty/exit`、模型工具名（`ssh_*`、`sftp_*`）。

## 为什么键名是 `ctx.sshSftp` 而不是 `ctx.ssh`

上游在 2026-09 合并中引入了自己的 SSH 连接服务 `packages/ssh/ssh`，同样占用 `ctx.ssh`。单一 Host TypeScript 程序只能有一个 `ctx.ssh`，两侧必须有一方让位：

- 上游 `ctx.ssh` 的消费者为 `fs-ssh`、`subprocess-ssh`、`sandbox-ssh` 三个包，且属于上游主线 API；
- fork 侧消费者为 `tool-ssh`、`host-ssh-remotes` 两个包，属于 fork 自研面。

因此 fork 侧改名。上游 `ctx.ssh` 与 fork `ctx.sshSftp` 是**两个不同的接缝**：前者是 POSIX 连接所有者（供远端 FS/子进程/沙箱使用），后者是 settings 支撑的 SSH/SFTP 连接定义注册表 + 模型工具面。文档与生成器据此区分：`docs/capability-seams.md` 的 seam 表同时列出两者，fork 侧 owner 显示为 `remote/ssh`（fork 包不在 `@deepseek-ai/dsh-` 扫描范围内）。

## 变更与踩坑

- 2026-09-17：Web SSH 面板新建目录（`ui-polish/src/client/SshPanel.tsx` 的 `handleMkdir`）调 `ssh.sftp.mkdir` 时未传 `recursive`，面板又允许输入 `a/b/c` 这类多级名称，于是父目录缺失时远端直接以 SFTP FAILURE 失败。修复为客户端传 `recursive: true`（网关 `sftpMkdir` 已转发 `request.recursive === true`，`ssh-local` 的 `ensureDir` 已实现逐级创建）。
- 实测方式：在 WSL（Ubuntu-22.04）起一个临时 sshd（独立配置、临时 host key 与 authorized_keys，端口 2222），用 `ssh-local` 连真实 OpenSSH/SFTP 调 `mkdir('/tmp/.../a/b/c', { recursive: true })` 建树成功，同一路径的非递归调用以 `SSH_SFTP_FAILED` 失败——证明差别就在该参数。
- 2026-09-17：网关的 `ptyClose` 原本只关终端通道，而共享连接按 definition 池化常驻（提供方 `connect` 返回同一句柄，直到显式关闭或提供方拆除），网关又没有关连接的方法，于是为终端建立的连接比终端活得久。修复：网关记录每个 PTY 建立在哪条连接上，最后一个持有它的终端关闭（含 shell 自行退出）即关闭该连接；exec/SFTP 按需重连；关连接失败只记日志、不上报给已关闭的终端。
- 2026-09-18：为远端工作区 provider 扩了接缝词汇——`SshConnection.openExec()`（活动全双工非交互通道，输出可重放、唯一一次 `onExit`、不设超时，终止归调用方）、`SshPtyOptions.command`（在 PTY 内经用户 shell 执行命令，缺省开登录 shell）、`SshSftp.openRead(path, {start, end})`（闭区间字节窗口）。三个成员的语义记在 `docs/subsystems/ssh-sftp.md`。
- 2026-09-18：`ssh-local` 的私钥权限探测把「密钥文件缺失」映射为 `SSH_AUTH_FAILED`（此前直接泄漏 `ENOENT`）；进程内 SSH 测试服务器的 exec 子进程改为 `spawn` + 管道 stdio 并转发数据/EOF，长驻命令与 PTY wrapper 才能双向流式。

## 关联页面

- 决策与冲突取舍：[合并上游 upstream/master（2026-09）](../decisions/2026-09-upstream-sync.md)
- 子系统文档：`docs/subsystems/ssh-sftp.md`（fork 接缝）与 `docs/subsystems/ssh.md`（上游连接所有者）
- 包族地图：`packages/remote/README.md`
- 远端工作区 provider：[远端工作区 provider（fs-sftp / subprocess-sftp）](../entities/remote-workspace-providers.md)
