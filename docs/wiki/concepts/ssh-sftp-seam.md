---
title: SSH/SFTP 能力接缝（ctx.sshSftp）
type: concept
tags: [ssh, sftp, capability-seam, fork, cordis]
created: 2026-09-17
updated: 2026-09-17
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

保持不变的名字（重命名时刻意未动）：settings 命名空间 `ssh`、Remote 命名空间 `ssh`、事件 `ssh/pty/output` 与 `ssh/pty/exit`、模型工具名（`ssh_*`、`sftp_*`）。

## 为什么键名是 `ctx.sshSftp` 而不是 `ctx.ssh`

上游在 2026-09 合并中引入了自己的 SSH 连接服务 `packages/ssh/ssh`，同样占用 `ctx.ssh`。单一 Host TypeScript 程序只能有一个 `ctx.ssh`，两侧必须有一方让位：

- 上游 `ctx.ssh` 的消费者为 `fs-ssh`、`subprocess-ssh`、`sandbox-ssh` 三个包，且属于上游主线 API；
- fork 侧消费者为 `tool-ssh`、`host-ssh-remotes` 两个包，属于 fork 自研面。

因此 fork 侧改名。上游 `ctx.ssh` 与 fork `ctx.sshSftp` 是**两个不同的接缝**：前者是 POSIX 连接所有者（供远端 FS/子进程/沙箱使用），后者是 settings 支撑的 SSH/SFTP 连接定义注册表 + 模型工具面。文档与生成器据此区分：`docs/capability-seams.md` 的 seam 表同时列出两者，fork 侧 owner 显示为 `remote/ssh`（fork 包不在 `@deepseek-ai/dsh-` 扫描范围内）。

## 关联页面

- 决策与冲突取舍：[合并上游 upstream/master（2026-09）](../decisions/2026-09-upstream-sync.md)
- 子系统文档：`docs/subsystems/ssh-sftp.md`（fork 接缝）与 `docs/subsystems/ssh.md`（上游连接所有者）
- 包族地图：`packages/remote/README.md`
