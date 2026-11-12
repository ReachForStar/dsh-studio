---
description: "在同一提示上比较多个模型，各自工作树隔离，胜者改动可单独应用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-arena

[English](README.md) | 中文

## 概述

`dsh-arena` 把同一提示同时交给多个模型，各自在一个从同一提交分出的 Git 工作树中执行，返回可比较的结果：回复文本、状态、耗时、轮次数、工具调用数、token 与改动文件。`ctx.arena.run()` 从不写主工作区；`ctx.arena.apply()` 事后再应用某个参选者的改动，`ctx.arena.remove()` 删除这些工作树。当部署需要按真实工作而非固定提示比较模型时使用它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把服务与 `agents`、`fs`、`subprocess`、`sandbox`、`sandboxPolicy` 一起挂载：

```yaml
- id: arena
  name: '@deepseek-ai/dsh-arena'
  config:
    workspaceRoot: /work/repo
    worktreeRoot: /work/.arena
```

`ctx.arena.run({ prompt, contenders })` 在所有参选者到达静止后返回一个 `ArenaRun`，其中每个参选者各有一条结果。`ctx.arena.runs()` 列出服务仍然保留的运行，`ctx.arena.apply(runId, label)` 把某个参选者的改动写入 `workspaceRoot`，`ctx.arena.remove(runId)` 删除该次运行的工作树与分支。每个参选者给出 `label`、`provider`、`model` 与可选的 `maxTokens`。

### 配置

- `workspaceRoot` — 绝对仓库路径；运行从它读取 `HEAD`，并把胜者改动写回它。
- `worktreeRoot` — 绝对目录，每次运行在其下建立一个子目录；必须位于 `workspaceRoot` 之外。
- `maxContenders` — 单次运行接受的最多参选者数，默认 4。
- `timeoutMs` — 单条 git 命令的截止时间，默认 60000。
- `graceMs` — 单条 git 命令的终止宽限期，默认 3000。
- `maxOutputBytes` — git 单条输出流的最大捕获字节数，默认 1048576。

<a id="understand-the-implementation"></a>
## 理解实现

`run()` 校验请求，用 `git rev-parse` 解析基础提交，为每个参选者用 `git worktree add -b` 建立分支与检出，并为每个参选者启动一个普通会话，其 `SessionHeader.cwd` 就是该检出。每个会话以 `dsh-arena` 来源种类的用户消息收到提示并跑完一整轮，因此比较衡量的是模型本身，而不是它们共享工作树的能力。

比较数据来自投递的 `session/event`：`turn/start`、`tool/call`、`assistant/message` 提供轮次数、工具调用数、回复与适配器上报的用量。全程不读历史，运行不拥有的会话事件被忽略。

收集 diff 时先用 `git add --all` 暂存检出，再读取 `git diff --cached <base>`，因此从不提交的模型也能给出完整改动集（含新增文件）。`apply()` 把该 diff 写成运行目录内的补丁文件，再应用到 `workspaceRoot`；`remove()` 用 `git worktree remove --force` 与 `git branch -D` 清理。

所有 git 命令都经 `subprocess` 与 `sandbox`，按 `sandboxPolicy` 解析出的部署策略执行，并清除会让嵌套调用指向别的检出的仓库选择变量。

<a id="further-exploration"></a>
## 进一步探索

- 单会话的隔离检出：`@deepseek-ai/dsh-experimental-worktree`。
- 委派子代理：`@deepseek-ai/dsh-subagent`。
- 本包对位的上游特性：qwen-code 源码的 `agents/arena/ArenaManager.ts`。

<a id="model-experience"></a>
## 模型体验

### Arena 参选者

#### 模型看到什么

每个参选者在自己的会话中以 `dsh-arena` 来源种类的用户消息看到同一段提示，外加其组合挂载的工具。参选者之间看不到彼此的输出，比较本身也不进入任何请求。

#### Token 影响

每个参选者都跑完一整轮，因此一次比较的成本是各参选者请求之和。回复只交给调用方，不会转发给另一个模型。

#### KV 缓存影响

参选者之间没有共享：每个都是独立会话、独立前缀。重复运行时也不会复用上一次的缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 没有界面与工具：本服务是编程接口，比较视图未实现。
- 不总结参选者「差在哪」：只比较回复与改动文件。
- 应用改动不跑测试、不请求审批，也不检测与运行开始后新改动的冲突。
- 运行会保留工作树直到调用 `remove()`；从不清理的部署会累积目录。
- 参选者会话在收敛后被释放，只保留其持久化日志。

<a id="dev-note"></a>
### 开发备注

git 操作全部经注入的能力执行，因此「比较可以写多少」由部署策略而非本包决定。
