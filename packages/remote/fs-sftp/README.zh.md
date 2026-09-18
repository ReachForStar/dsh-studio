---
description: "通过 SFTP 在远端 POSIX 主机上提供 ctx.fs：远端规范路径、带版本守卫的编辑与原子发布。"
kind: "package-reference"
---

# @reachforstar/dsh-fs-sftp

[English](README.md) | 中文

## 概述

本包把 Harness 文件系统指向一台可通过已保存的 `ctx.sshSftp` 连接访问的远端 POSIX 主机，让全部文件工具、工作区文件界面与 diff 都落在该主机上。远端路径经远端 shell 规范化，编辑带版本守卫，写入经临时文件 + SFTP rename 原子发布。远端只需 OpenSSH，无需远端 Node 或 helper。

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

用本后端替代 `@deepseek-ai/dsh-fs-sandbox` 或 `@deepseek-ai/dsh-fs-local`，与 `@reachforstar/dsh-ssh` 及沙箱策略一同挂载。

```yaml
- id: fs
  name: '@reachforstar/dsh-fs-sftp'
  config:
    connection: build-box
    cwd: /home/deploy/project
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `connection` | 必填 | 文件所在主机的已保存 `ctx.sshSftp` 连接名或 id。 |
| `cwd` | 必填 | 相对路径的远端基准目录；绝对路径忽略它。 |
| `diffBasisMaxBytes` | `10485760` | 覆盖 diff 每一侧的排他字节上限；更大或非文本的原内容按「无基准」上报。 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是全部可接受字段的权威来源。

### 何时选择

当 Agent 需要读写的文件位于远端 POSIX 主机、且该主机没有可安装 helper 的 Node 运行时，选择本后端。远端是 Windows（路径规范化、无覆盖创建与权限复制都经远端 shell）、需要检出「同一毫秒内等长改写」这类版本变化、或大文件传输必须走并行 SFTP 通道时不要选它——这些由 `@deepseek-ai/dsh-fs-ssh` 覆盖。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

- **路径标识**：`resolve()` 对已存在路径经远端 shell 取 realpath（`cd <path> && pwd -P`）；对缺失路径取最深的已存在祖先做 realpath 再拼回缺失后缀，使标识在创建前后保持一致。仅当 SFTP 侧也能看到该路径时才采信其回报。
- **版本**：文件版本是远端 stat 的 `mtime:size:mode` 三元组。写入与编辑可要求 `replaceIfVersion`（不匹配以 `FS_STALE_VERSION` 拒绝）或 `createIfAbsent`（已存在以 `FS_NOT_OBSERVED` 拒绝）。
- **原子发布**：变更按 targetKey 串行化，随后在目标目录暂存 `.dsh-<name>.<uuid>.tmp` 并用 SFTP rename 发布。`createIfAbsent` 用 `ln` 硬链接发布，让并发创建者胜出；仅当 exec 世界看不到暂存路径时才回退到 rename。
- **沙箱围栏**：按调用策略判定：`read-only` 拒绝、`danger-full-access` 放行、`workspace-write` 要求规范化目标位于某个 `writableRoots()` 条目之下；读取不受限。
- **文本机制**：二进制拒绝（前 8192 字节含 NUL）、严格 UTF-8 解码、行尾检测/还原与字面量替换匹配均来自 `@deepseek-ai/dsh-fs` 的共享文本模块，因此 fs 错误分类（`FS_NOT_TEXT`、`FS_EDIT_NOT_FOUND`、`FS_AMBIGUOUS_EDIT`）与本地后端完全一致。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 能力](../ssh/README.zh.md)——连接接缝与已保存定义。
- [本地 ssh2 提供方](../ssh-local/README.zh.md)——本后端之下的传输层。
- [本地文件系统后端](../../fs/fs-local/README.zh.md)——本后端在远端复刻的语义。
- [SFTP 子进程提供方](../subprocess-sftp/README.zh.md)——同一连接上的命令与终端。
- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——共享操作与错误含义。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由文件系统消费方——它们呈现远端路径与文件内容，并自行拥有全部工具与提示词。

#### KV Cache effect

本后端不贡献请求前缀内容。模型面工具与结果由其消费方拥有。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **仅支持 POSIX 远端**：路径规范化、无覆盖创建与权限复制都经远端 shell（`cd`/`pwd -P`、`ln`、`chmod`）；Windows 远端无法满足。
- **同一毫秒内等长且同权限的改写不改变版本**：守卫比较 `mtime:size:mode`，这类变化不会被判为过期。
- **整文本读取会把文件载入 Host 内存**：`readText` 没有大小上限；大文件请用 `streamText`、`readByteRange` 或消费方自己的限额。
- **每次传输一条 SFTP 流**：大文件上传下载均为顺序；并行 `fastGet`/`fastPut` 通道只存在于 `@deepseek-ai/dsh-fs-ssh`。
- **exec 世界与 SFTP 世界必须一致**：仅当两侧都看得到某路径时才采信它做规范化与暂存校验，视图分叉的测试挂载会退化到字面显示路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作上下文——点击展开</summary>

不发布 invariant 伴随包。可观察义务由 SSH 传输保证并经 `dsh-fs` 消费；本后端不新增独立可观察的状态关系。

</details>
