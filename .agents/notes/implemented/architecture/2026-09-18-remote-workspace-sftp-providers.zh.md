# Agent Note: 基于 fork SSH 接缝的远端工作区 provider

Status: implemented

[English](2026-09-18-remote-workspace-sftp-providers.md) | 中文

## 问题

fork 需要把 Agent 的文件系统与进程执行世界放到一台远端 POSIX 主机上：Web 文件面板、Web 终端与模型的文件/命令行工具都针对该主机读写与执行，而 Harness 本身继续在本地运行。已保存的 `ctx.sshSftp` 连接经 settings 注册表与 `ssh2` 客户端已具备认证后的 SSH 访问，但接缝只提供缓冲式 `exec` 与整文件 SFTP 读取；上游的远端 provider（`fs-ssh`、`subprocess-ssh`）则要求在另一侧部署 helper 产物并具备远端 Node 运行时。

## 决策

`packages/remote/` 下新增两个 provider 包，在一条已保存的 `ctx.sshSftp` 连接上实现 Harness 的执行接缝：

- `@reachforstar/dsh-fs-sftp` 注册 `ctx.fs`（`SftpFileSystem`）。
- `@reachforstar/dsh-subprocess-sftp` 注册 `ctx.subprocess`（`SftpSubprocessRuntime`）。

远端只需 OpenSSH——其 `sftp-server` 子系统与 POSIX 登录 shell；不在远端安装或上传任何东西。

### 新增的接缝词汇

`ssh` 增加 `SshConnection.openExec(request)`：一条活动的全双工非交互通道，其 stdout/stderr 订阅会重放早期分片，`write`/`endStdin` 喂给命令，唯一一次 `onExit` 报告结算会话；它不设超时，因为终止由调用方经 `close()` 或请求的 abort 信号拥有。`SshPtyOptions` 接受 `command`（在 PTY 内经用户 shell 执行），`SshSftp.openRead` 接受闭区间 `{start, end}` 字节窗口。

### 文件系统语义

- 路径标识来自远端 shell：`resolve()` 对已存在路径用 `cd <path> && pwd -P` 取 realpath；对缺失路径取最深已存在祖先的 realpath 再拼回缺失后缀。
- 文件版本是远端 stat 的 `mtime:size:mode`；写入与编辑遵守 `replaceIfVersion` 与 `createIfAbsent` 守卫。
- 变更按 targetKey 串行，在目标目录暂存 `.dsh-<name>.<uuid>.tmp`，再以 SFTP rename 发布；`createIfAbsent` 用 `ln` 发布，使并发创建者胜出。
- 每次调用的 `ctx.sandboxPolicy` 模式在规范化后的远端路径字符串上围栏变更；读取不受限。
- 二进制拒绝、严格 UTF-8 解码、行尾检测与还原、字面量替换匹配移入 `@deepseek-ai/dsh-fs` 的 `text.ts`，使 fs 错误分类与 `fs-local` 完全一致。

### 子进程语义

- 一次 spawn 发送一条 shell 命令：`cd <cwd> 2>/dev/null || exit 126`，随后经 `env` 施加显式环境层（`-u` 先删除再赋值），最后 `exec <argv>`。
- 收集式 stdio 复用 `subprocess-local` 的 `OutputCollector`；溢出文件落在 Host 临时目录。`stdio.control: 'pipe'` 直接失败，因为 SSH exec 通道只承载 stdin、stdout 与 stderr。
- 终端分配一条 PTY，其 wrapper 在 `exec` 命令前打印带令牌的 pid 行；前台判定扫描 `/proc`（`/proc/<pid>/syscall` 可读时精确），回退 `ps -o tpgid=`。

### 本次一并修复的本地 provider 缺陷

- `ssh-local` 的私钥权限探测把缺失的密钥文件映射为 `SSH_AUTH_FAILED`，不再泄漏 `ENOENT`。
- POSIX 远端 cwd 子套件启动其测试服务器；此前它默认服务器已存在却从未启动。
- 进程内 SSH 测试服务器改为以管道 stdio spawn exec 子进程并转发通道数据与 EOF，使长驻命令与 PTY wrapper 双向流式传输；可选 `detachedExec` 让每个 exec 子进程拥有自己的进程组，供前台信号测试使用。

## 备选方案

**复用上游 helper 方案。** 否决：`fs-ssh` 与 `subprocess-ssh` 需要安装 helper 与远端 Node 运行时，且连接走上游 `ctx.ssh` 连接所有者，而非 fork 的 settings 支撑注册表 `ctx.sshSftp`。

**扩展缓冲式 `exec` 承载进程。** 否决：它缓存输出且仅在退出时结算，无法表达流式 stdin/stdout/stderr、收集式读取与长驻句柄。

**让一次性命令走 PTY 通道。** 否决：PTY 把 stderr 并入终端流并引入回显与行规程语义，收集式与管道 stdio 不应继承这些行为。

**连接时上传 helper 脚本。** 否决：目标就是远端只需 OpenSSH；PTY wrapper 打印 pid 行取代了最初设计所需的远端暂存文件。

**在 `fs-sftp` 内重复文本机制。** 否决：二进制、UTF-8、行尾与编辑匹配规则及其错误码在本地与远端后端之间不得漂移。

**把 `fs-local`/`subprocess-local` 参数化为可换传输层。** 否决：每个接缝 provider 都绑定一个执行世界；独立包让本地后端及其覆盖率不受影响。

## 后果

- 任意 OpenSSH 主机都能成为工作区。Windows 远端不支持，因为规范化、无覆盖创建、权限复制与终端 wrapper 都依赖远端 POSIX shell。
- 版本标识 `mtime:size:mode` 弱于内容哈希：同一毫秒内等长且同权限的改写保持原版本。
- 子进程 provider 没有控制通道；连接断开时也没有远端进程组清理。终止即关闭会话，因此自行脱离的远端进程可能比句柄活得更久。
- 两个 provider 共享 fork 注册表的一条连接句柄且从不关闭它（其他消费方可能持有）；provider 销毁会终止并等待每个存活进程与终端。
- 换 provider 只需 profile 行覆盖（`fs-sandbox` → `fs-sftp`、`subprocess` → `subprocess-sftp`，外加 `sandbox-policy.workspaceRoot`），Web 文件面板、Web 终端与模型工具即整体切到远端工作区，无需改代码。
- 接缝词汇有所增长，新会话、命令与读取窗口成员记录在 `docs/subsystems/ssh-sftp.md`。

## 测试

- `fs-sftp` 与 `subprocess-sftp` 针对进程内 `ssh2` 测试服务器（SFTP 映射到临时根、exec 经真实 POSIX shell）有 42 条定向测试；同一次运行中 `ssh-local`、`fs`、`fs-local` 套件全部通过。
- 这些套件绑定 POSIX，已列入 `vitest.config.ts` 的 Windows 不支持集合，其覆盖率由 Linux CI 通道持有。
- 与改动前的 `ssh-local` 文件对照复现了修复所针对的两个缺陷（`ENOENT` 泄漏与未启动的 cwd 子套件）；ssh2 的 `No response from server` 清理噪声在两次运行中都出现，属既有问题。
- 手工验证：`web-lab` profile 把两个 provider 挂在已保存的 `wsl` 连接上，指向 WSL Ubuntu 检出一份仓库；此后 Web 文件面板与 Web 终端即操作该远端工作区。
