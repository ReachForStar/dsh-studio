---
description: "输入前执行的推测门控、overlay 路径规划与预测运行方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-speculation

[English](README.md) | 中文

## 概述

`dsh-speculation` 决定推测运行在用户提交输入前可以做什么，提供把写入挡在工作区之外的 overlay 文件系统，并附带产出预测的运行方。只读工具原样执行；策略允许写入时，文件写入被重定向到 overlay 路径；其余工具一律停止推测。`OverlayFileSystem` 读取时优先使用 overlay 副本，所有写入都落在 overlay，并暴露 `commit` 与 `discard`，使「用户接受」成为内容进入工作区的唯一路径。运行方模块把已完成的轮次变成「预测请求 + 预测工具调用」，再门控并预先执行。

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

推测运行方对每个预测调用调用 `gateToolCall`，对被重定向的调用应用 `rewriteArguments`，并在第一个 boundary 处停止。

### 挂载随包运行方

`@deepseek-ai/dsh-speculation/runner` 是 Cordis 插件：每个轮次结束后，它向一条辅助路由索取最可能的下一次请求，以及预先算出该请求所需的工具调用，然后门控并执行这份计划。它需要 `llm`、`tools`、`fs` 三个服务。

```yaml
- id: speculation
  name: '@deepseek-ai/dsh-speculation/runner'
  config:
    workspaceRoot: /work/repo
    overlayRoot: /work/.speculation
    allowWrites: true
    provider: deepseek
    model: deepseek-chat
```

当用户的下一条消息与预测请求归一化后相同且 `allowWrites` 已开启时，运行方把 overlay 副本提交进工作区；否则丢弃。两种结果都以 `speculation/proposal` 与 `speculation/outcome` 记入会话日志，且不进入模型面。

### 配置

- `workspaceRoot` — overlay 映射的绝对工作区根。
- `overlayRoot` — 接收推测写入的绝对 overlay 根；必须位于 `workspaceRoot` 之外。
- `allowWrites` — 写入是否可重定向到 overlay。默认 `false`：没有显式开启时不执行任何推测写入，运行方也不会把写工具提供给预测。
- `readOnlyTools` / `writeTools` — 工具分类覆盖；留空时使用内置集合。
- `pathArgumentKeys` — 携带文件路径的参数键；留空时使用 `file_path`、`path`、`directory`。
- `provider` / `model` — 预测请求的显式路由；两者必须同时配置。
- `maxInputBytes`、`maxOutputTokens`、`timeoutMs` — 单次预测请求的上限。
- `maxSteps` — 最多执行的预测调用数。
- `maxRequestChars` — 日志中保存的预测请求文本长度上限。

<a id="understand-the-implementation"></a>
## 理解实现

`gateToolCall` 返回 `allow`、`redirect`（带参数键与 overlay 路径）或 `boundary`（带原因）。`overlayPath` 只在路径仍位于工作区内时把它映射到 overlay；越界路径变成 boundary。`gatePlan` 对整份预测计划套用同一规则，并保留第一个 boundary 之前的所有步骤。

门控刻意保守：写入需要 `allowWrites`，未知工具是 boundary，外部网络工具无论配置如何都在固定 boundary 集合中。

`OverlayFileSystem` 是 `FileSystem` 代理：解析走底层提供者，每次读取先探测 `<overlayRoot>/<相对路径>`，所有变更都落到那里。它记录自己产出的每个 overlay 路径，因此 `commit` 只把这些文件写回，`discard` 只删除这些文件。同样三段操作也导出为 `seedOverlay`、`commitOverlay` 与 `discardOverlay`，供「改写参数而不代理提供者」的运行方共用。

运行方为每个已完成的会话轮次保留一次运行记录。`executePlan` 先套用 `gatePlan`，把每个被重定向调用的路径参数改写进 overlay，预先把工作区文件复制到 overlay 副本（使编辑打开的内容与模型读过的一致），再逐个通过 `ctx.tools.execute` 在不带 Agent 的情况下派发，并记录产出的 overlay 配对。不带 Agent 意味着需要审批的工具在推测期直接失败，而不是弹出审批。overlay 副本只能经 `commitOverlay` 进入工作区。

<a id="further-exploration"></a>
## 进一步探索

- 上游参考实现：qwen-code 源码的 `followup/speculationToolGate.ts`。
- 运行方需要代理的文件提供者抽象：`@deepseek-ai/dsh-fs`。
- 同门类的展示数据包：`@deepseek-ai/dsh-step-summary`、`@deepseek-ai/dsh-followup`。

<a id="model-experience"></a>
## 模型体验

### 推测门控

#### 模型看到什么

什么也没有。门控不发起请求、不记录事件；它只对推测运行方已经产出的工具调用做分类，对每次 `gateToolCall` 返回 `allow`、`redirect` 或 `boundary`。

#### Token 影响

0 token：门控是对 `gateToolCall` 参数完全本地的同步逻辑。

#### KV 缓存影响

没有影响：不涉及任何模型请求。

### 推测运行方

#### 模型看到什么

预测期间什么也看不到。运行方每个已完成轮次发起一次辅助请求，其消息带专属来源种类，模型自身的请求从不携带预测内容。后续轮次只会看到提交产生的文件状态，与用户自己做过这些编辑时一致。

#### Token 影响

每个已完成轮次一次短辅助请求，受 `maxInputBytes` 与 `maxOutputTokens` 限制，外加上被预测调用自身的执行开销。会话请求不变，其 token 与提示缓存不受影响。

#### KV 缓存影响

会话侧没有影响：预测是独立的 `speculation` 请求，使用自己的消息列表。提交写入会改变下一轮的文件内容，那属于普通工具输出。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 预测期的只读调用不留下产物：只有提交的 overlay 副本会保留，因此只读预测消耗 token 却没有模型可见的结果。
- 预测期读取看到的是工作区文件，而不是同一计划中前面步骤产出的 overlay 副本。
- 提交无冲突检测：`commit` 直接覆盖工作区文件，不比较 overlay 副本起始版本。
- 无 shell 门控：未实现命令安全分类；shell 调用一律 boundary。
- 无界面：overlay 是给运行方使用的 API，不是面向用户的界面。

<a id="dev-note"></a>
### 开发备注

门控是纯函数，运行方无需执行任何操作即可测试其安全策略；运行方把执行与收敛分成两步，便于在没有模型的情况下分别测试。
