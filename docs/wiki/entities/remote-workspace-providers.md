---
title: 远端工作区 provider（fs-sftp / subprocess-sftp）
type: entity
tags: [ssh, sftp, ctx.fs, ctx.subprocess, 远端工作区, fork]
created: 2026-09-18
updated: 2026-09-18
sources: []
status: active
---

# 远端工作区 provider（fs-sftp / subprocess-sftp）

## 职责

把 Harness 的**执行世界**搬到远端 POSIX 主机：`@reachforstar/dsh-fs-sftp` 注册 `ctx.fs`，`@reachforstar/dsh-subprocess-sftp` 注册 `ctx.subprocess`，两者都跑在一条已保存的 `ctx.sshSftp` 连接上。远端只需 OpenSSH（`sftp-server` 子系统 + POSIX 登录 shell），不安装也不上传任何 helper，因此与上游 `packages/ssh/{fs-ssh,subprocess-ssh}`（要求远端 Node + helper 产物）是两条独立路线。

## 关键文件与接口

| 位置 | 内容 |
| --- | --- |
| `packages/remote/fs-sftp/src/index.ts` | `SftpFileSystem extends FileSystem`：`resolve`/`stat`/`lstat`/`readText`/`streamText`/`readBytes`/`readByteRange`/`listDir`/`writeText`/`writeBytes`/`editText` |
| `packages/remote/subprocess-sftp/src/index.ts` | `SftpSubprocessRuntime extends SubprocessRuntime`：`resolveExecutable`/`terminalEnvironment`/`spawn`/`spawnTerminal` |
| `packages/fs/fs/src/text.ts` | 两个后端与 `fs-local` 共用的纯文本机制：二进制采样、严格 UTF-8 解码、行尾检测/还原、字面量编辑与错误分类 |
| `packages/remote/ssh/src/types.ts` | 本批新增的接缝词汇：`SshExecSession`/`SshOpenExecRequest`、`SshPtyOptions.command`、`SshSftp.openRead(path, {start,end})` |
| `packages/remote/ssh-local/src/index.ts` | 上述词汇的 `ssh2` 实现（`LocalExecSession`、PTY 带命令、SFTP 读取窗口） |

配置：两者都只有 `connection`（fs 另有 `cwd` 与 `diffBasisMaxBytes`，默认 10 MiB）。

## 设计要点

- **路径标识**：`resolve()` 经远端 shell `cd <path> && pwd -P` 取已存在路径的 realpath；缺失路径取最深已存在祖先的 realpath 再拼回后缀，使标识在创建前后稳定。仅当 SFTP 侧也能看到该路径时才采信 shell 的回报。
- **版本**：远端 stat 的 `mtime:size:mode` 三元组；`replaceIfVersion` 不匹配抛 `FS_STALE_VERSION`，`createIfAbsent` 遇已存在抛 `FS_NOT_OBSERVED`。
- **原子发布**：按 targetKey 串行暂存 `.dsh-<name>.<uuid>.tmp` 再 SFTP rename；`createIfAbsent` 用 `ln` 让并发创建者胜出，仅在 exec 世界看不到暂存路径时回退 rename。
- **沙箱围栏**：每次调用的 `ctx.sandboxPolicy` 模式（`read-only` 拒绝 / `workspace-write` 要求规范化路径落在 `writableRoots()` 下 / `danger-full-access` 放行）作用于规范化后的远端路径字符串；读取不设围栏。
- **文本机制共享**：二进制/UTF-8/行尾/编辑匹配从 `fs-local` 抽到 `dsh-fs` 的 `text.ts`，远端与本地后端错误码一致，避免两套语义漂移。
- **子进程命令构造**：一条 shell 命令 `cd <cwd> 2>/dev/null || exit 126`，显式环境层经 `env` 工具（`-u` 先删再赋值，避免外层 `PATH` 未设置破坏后续 exec），最后 `exec <argv>`；收集输出复用 `subprocess-local` 的 `OutputCollector`（溢出文件落在 **Host** 临时目录）。
- **终端**：PTY wrapper 先打印带令牌的 pid 行再 `exec` 命令，provider 读该行（5 秒预算）获知 pid；前台进程组扫 `/proc`（`/proc/<pid>/syscall` 可读时精确），否则回退 `ps -o tpgid=`；`signalForeground()` 把接缝五种信号映射为 POSIX 编号并对进程组发信号。
- **无控制通道**：SSH exec 通道只有 stdin/stdout/stderr，`stdio.control: 'pipe'` 直接失败，不静默丢 fd 3。

## 上下游依赖

- 上游：`ctx.sshSftp`（fork 的 settings 支撑连接注册表 + `ssh2` 客户端）。两个 provider 共享同一句柄且从不关闭它；销毁时中止生命周期并终止、等待全部存活进程与终端。
- 下游：`tool-fs`/`tool-fs-search`/`tool-str-replace-editor`、`workspace-files`（Web 文件面板）、Bash/终端/LSP/ptc-runtime 消费方——它们都不改一行代码，换 provider 即换执行世界。

## 验证与踩坑（2026-09-18）

- 验证：`fs-sftp` + `subprocess-sftp` 42 条测试在 WSL（Ubuntu-22.04，仓库副本 `/home/xyx/dsh-test` 带 Linux `node_modules`）全通过；同轮 `ssh-local`/`fs`/`fs-local` 共 25 个测试文件 446 条通过（含本批改动后的复跑）。Windows 本机无法跑这两套：`vitest.config.ts` 把它们列为不支持项，本机 `node_modules` 也只有 Windows 原生二进制（WSL 里跑必须用 WSL 侧的仓库副本）。Windows 侧跑 `remote/{ssh,ssh-local,tool-ssh}` + `fs/{fs,fs-local}` + `a2a` + `pi-agent-loop` + `ui-sidebar-documentpreview` 共 68 文件 757 条通过。
- **未达仓库门禁的覆盖率**：实测 `fs-sftp/src/index.ts` 73.8% 语句 / 62.9% 分支，`subprocess-sftp/src/index.ts` 80.8% / 65.4%，距 per-file 100% 还有差距；补测项与其余 fork 包的同类欠账记在[fork 自研包的门禁红项清单](../queries/fork-gate-debt.md)。
- 说明：`ssh-local` 套件结束时有 3 条 ssh2 `No response from server` 未捕获异常（同样出现在改动前的 HEAD 上），会让 `pnpm vitest run` 退出码为 1，属既有噪声。
- 对照 HEAD 复现出的两个既有缺陷（随本批修复）：`ssh-local` 私钥缺失时泄漏 `ENOENT`（应为 `SSH_AUTH_FAILED`）；POSIX 远端 cwd 子套件从未启动测试服务器。
- 测试服务器改造：exec 子进程从 `exec` 回调式改为 `spawn` + 管道 stdio，并转发通道数据与 EOF，长驻命令与 PTY wrapper 才能双向流式；可选 `detachedExec` 给每个 exec 子进程独立进程组（前台信号测试需要）。
- 踩坑（profile patch）：patch 的 `name` 字段是**命中行的插件名校验**，不是替换。写 `- id: fs-sandbox` + 另一个 `name` 会被判 `name mismatch` 并**静默跳过**，`--dump-config` 也只留一行 warning。正确做法是 `disabled: true` 原行 + `insert` 新行（id 用新名字）。
- 踩坑（Web 工作区）：`workspace.json` 里的路径由**宿主** `node:fs` realpath 校验（`packages/workspace/workspace/src/paths.ts`），远端路径 `/home/xyx/dsh-test` 在 Windows 上无法解析，会话 attach 报 `session/workspace-attach-failed`。上游 `packages/ssh/ssh` README 也写明同一限制：「Web workspace UI paths still assume host filesystem access; use headless or a custom composition」。因此**远端工作区目前只能在 headless / 自定义组合里用**，Web 面板与终端跟随 `ctx.fs`/`ctx.subprocess` 远端化的前提是会话本身不经过 Web 工作区校验。
- 踩坑（web-lab）：settings 默认 preset 是 `pi`，而 `web-lab` patch 未插 `pi-agent-loop`，任何会话创建都以 `no agent factory registered for backend "pi"` 失败；已补（与 `web` profile 同配置）。目录选择器（`directory-picker-auto`）是宿主本地的，也无法用来选远端目录。

## 关联页面

- 接缝三角色与命名：[SSH/SFTP 能力接缝](../concepts/ssh-sftp-seam.md)
- 试验 profile 与实验插件现状：[实验能力试验 profile（web-lab）](../queries/web-lab-profile-and-experimental-plugins.md)
- 决策记录：[远端工作区 provider（Agent Note）](../../../.agents/notes/implemented/architecture/2026-09-18-remote-workspace-sftp-providers.md)
- 门禁欠账：[fork 自研包的门禁红项清单](../queries/fork-gate-debt.md)
- 子系统参考：`docs/subsystems/ssh-sftp.md`（`openExec`、PTY `command`、读取窗口）
