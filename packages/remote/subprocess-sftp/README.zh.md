---
description: "通过 SSH exec 与 PTY 通道在远端 POSIX 主机上提供 ctx.subprocess：收集或管道 stdio、终端与前台信号。"
kind: "package-reference"
---

# @reachforstar/dsh-subprocess-sftp

[English](README.md) | 中文

## 概述

本包让你通过已保存的 `ctx.sshSftp` 连接在远端 POSIX 主机上运行命令与交互式终端，使 shell 工具、终端与语言服务器看到的文件与 SFTP 文件系统后端一致。远端只需 OpenSSH：命令经 exec 通道流式传输，PTY 会话从一行 wrapper 输出中获知自身 pid，终止作用于同一会话。远端无法安装 Node 运行时或 helper 时选择本包。

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

用本提供方替代 `@deepseek-ai/dsh-subprocess-local`，与 `@reachforstar/dsh-ssh` 及共享该连接的 SFTP 文件系统后端一同挂载。

```yaml
- id: subprocess
  name: '@reachforstar/dsh-subprocess-sftp'
  config:
    connection: build-box
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `connection` | 必填 | 命令与终端所运行主机的已保存 `ctx.sshSftp` 连接名或 id。 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是全部可接受字段的权威来源。

### 何时选择

当执行世界是一台仅通过 OpenSSH 访问、未部署 helper 的远端 POSIX 主机，且 Bash、终端、LSP 与 ptc-runtime 消费方应与文件系统后端操作同一批远端文件时，选择本提供方。请求需要独立全双工控制通道（`stdio.control: 'pipe'` 会被拒绝）、远端缺少 Linux `/proc` 与 `ps` 而必须精确判定前台进程组、或远端是 Windows 时不要选它。helper 方案由 `@deepseek-ai/dsh-subprocess-ssh` 覆盖。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

- **共享一条连接**：每个进程与终端都开在由 `ctx.sshSftp` 解析出的连接上；本提供方从不关闭它，因为其他消费方可能持有同一句柄。销毁时先中止提供方生命周期，再终止并等待全部存活进程与终端。
- **命令构造**：一次 spawn 发送一条 shell 命令：`cd <cwd> 2>/dev/null || exit 126`，随后经 `env` 工具施加显式环境层（`-u NAME` 先做删除再赋值，避免外层 `PATH` 未设置破坏后续 exec），最后 `exec <argv>`。参数与路径按单引号引用。
- **Stdio**：`stdin` 接受固定载荷或管道；`stdout`/`stderr` 接受 `pipe`、`inherit` 或带界收集，其溢出文件写在 Host 临时目录。调用方主动终止以空 exit code 与 signal 结算，而非失败。
- **可执行文件查找**：`resolveExecutable()` 用 `[ -x … ]` 探测绝对路径，拒绝含 `/` 的相对路径，并用 `command -v`（可带 `PATH` 覆盖）解析裸名；未命中抛 `SubprocessExecutableNotFoundError`。
- **终端**：PTY wrapper 在 `exec` 命令前打印一行带令牌的 pid 输出；本提供方读取该行（5 秒预算）获知会话 pid，随后扫描 `/proc`（`/proc/<pid>/syscall` 可读时精确）检查前台进程组，否则回退 `ps -o tpgid=`。`signalForeground()` 把接缝的五个信号映射为 POSIX 编号并对进程组发信号。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [子进程子系统](../../../docs/subsystems/subprocess.zh.md)——spawn、收集、终端与生命周期 API。
- [SSH 能力](../ssh/README.zh.md)——连接接缝与已保存定义。
- [本地 ssh2 提供方](../ssh-local/README.zh.md)——本提供方之下的传输层。
- [SFTP 文件系统后端](../fs-sftp/README.zh.md)——同一连接上的文件系统提供方。
- [本地子进程提供方](../../subprocess/subprocess-local/README.zh.md)——本提供方在远端复刻的语义。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 Bash、终端、LSP 与 ptc-runtime 消费方——命令语义、输出上限与执行期限由它们拥有。

#### KV Cache effect

本提供方不贡献请求前缀内容。模型面工具与结果由其消费方拥有。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **没有控制通道**：SSH exec 通道只承载 stdin/stdout/stderr，因此 `stdio.control: 'pipe'` 直接失败，而不是静默丢弃 fd 3 流量。
- **前台判定依赖远端工具**：精确的 `inputWaiting` 需要可读的 `/proc/<pid>/syscall`；否则退化为 `tpgid` 轮询，无法解析进程组时 `signalForeground()` 抛错。
- **终止即关闭会话**：远端命令通过关闭其通道被杀，因此它自行脱离的进程可能比句柄活得更久，连接断开时远端清理无法确认。
- **收集输出的溢出文件在 Host 侧**（非远端），且不随提供方销毁删除。
- **需要 POSIX shell**：`cd` 前缀、环境层与终端 wrapper 都假设 POSIX shell；`cd` 失败以 126 退出。
- **环境变量名会校验**为 shell 标识符；终端若在 5 秒内拿不到 wrapper 的 pid 则分配失败。
- **连接断开会使在途句柄失败**，不会自动重放任何工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作上下文——点击展开</summary>

不发布 invariant 伴随包。可观察义务由 SSH 传输保证并经 `dsh-subprocess` 消费；本提供方不新增独立可观察的状态关系。

</details>
