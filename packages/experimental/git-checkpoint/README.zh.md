---
description: "创建并恢复 Git 检查点的 /checkpoint 人工命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-git-checkpoint

[English](README.md) | 中文

## 概述

使用 `@deepseek-ai/dsh-git-checkpoint` 用 Git 快照并恢复会话工作目录。`/checkpoint` 执行 `git stash create` 并记住 stash 引用；`/checkpoint restore` 用该引用执行 `git stash apply`；`/checkpoint clear` 忘记引用。适用于在风险操作前或迁移工作时会话工作目录是 Git 工作树的部署。

## 目录

- [使用方法](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用方法

在提供 shell 服务的组合中挂载本插件，然后在交互界面执行命令。

```yaml
- name: '@deepseek-ai/dsh-git-checkpoint'
  config:
    timeoutMs: 10000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `10000` | 单条 git 命令的截止时间 |

```text
/checkpoint
/checkpoint restore
/checkpoint clear
```

该命令要求会话工作目录位于 Git 工作树内。干净的工作区不产生检查点，并会报告。

<a id="understand-the-implementation"></a>
## 实现说明

服务通过 `ctx.shell` 在会话工作目录执行 `git rev-parse --is-inside-work-tree`、`git stash create` 与 `git stash apply`。它按会话在进程内存中保存最近一次 stash 引用。命令处理器校验子命令、报告引用前缀，并在失败时上抛 git 的 stderr。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-shell`](../../shell/shell/README.zh.md) —— 命令执行服务。
- [`dsh-commands`](../../interaction/commands/README.zh.md) —— 命令注册表与执行生命周期。

<a id="model-experience"></a>
## 模型体验

### Git 检查点

#### 模型看到什么

什么也没有。该命令是人工命令：其输入与结果由命令生命周期记录，没有消息进入对话。`git` 输出不到达模型。

#### Token 影响

零。不发起模型请求。

#### KV 缓存影响

无：对话不变。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 检查点引用存于进程内存；重启后忘记引用，但 stash 仍在仓库中，可通过 `git stash list` 查看。
- 没有每回合自动捕获，也没有 fork 时自动恢复：命令是显式的。
- 每个会话只记住最近一次引用。
- `git stash create` 不写 stash reflog，丢掉的引用只能经 Git 自身的 stash 列表恢复。

<a id="dev-note"></a>
### 开发备注

服务刻意把引用保存在内存：持久事实是 Git 已保存的 stash 对象，而命令是操作者动作，不是会话历史。
