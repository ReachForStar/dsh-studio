---
description: "面向代理的持久项目与用户记忆笔记：MEMORY.md 基线上下文，随文件编辑保持最新。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-notes

[English](README.md) | 中文

## 概述

`dsh-memory-notes` 从 `MEMORY.md` 文件为代理提供持久记忆：用户全局笔记在 `<dsh home>/memory` 下，项目笔记在最近的持有所配置根标记的目录下。两者在首个请求中以一条受预算约束的笔记消息进入上下文，并在每个 pre-step 重新读取以保持最新——由先前工具调用造成的编辑对后续步骤可见；文件消失则移除对应块。共享的字符预算约束整条笔记，超出部分以标记截断；非正预算禁用注入。

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

向项目添加 `/MEMORY.md`（或个人笔记放在 `<dsh home>/memory/MEMORY.md`）并挂载本插件；笔记在每个步骤的模型可见表面进入，位于被认领提示之前。

### 代理获得什么

记忆笔记作为 `user/message` 进入，携带仅归因的 `memory-notes` 来源，放置在被认领批次之后，使直接提示前置。用户笔记先于项目笔记加载，共享 `maxChars` 预算；每个文件标注其层与展示路径。内容与来源相同的重复笔记是空操作；内容变化的笔记替换先前版本；删除的笔记从下一个决策中移除对应块。

### 配置

- `memoryFileNames` — 候选文件名，按优先级顺序；每层取第一个存在的文件。默认 `MEMORY.md`。
- `projectRootMarkers` — 向上查找时标识项目根的目录条目。默认 `.git`。
- `maxChars` — 整条笔记的字符上限；超出部分以标记截断，非正数禁用注入。默认 `20000`。

`dsh-base` 不启用本插件：记忆笔记是可选注入的上下文来源，由需要持久记忆的 profile 或宿主挂载。

<a id="understand-the-implementation"></a>
## 理解实现

`apply` 注册一个 `agent/pre-step` 监听器，委托给 `applyPreStepMemory`：解析工作目录，向上查找项目根，探测用户记忆目录与项目根下的候选文件，在共享预算内读取，并把结果笔记折叠到被认领批次之后。所有读取经过调用方作用域的 `ctx.fs` 提供者，沙箱策略原样生效，每次文件访问均感知中止。

投影不保留会话状态：注入内容在每个 pre-step 由文件推导，因此笔记始终最新，会话日志也能凭 `memory-notes` 来源精确重建。

<a id="further-exploration"></a>
## 进一步探索

- `agent/pre-step` 瀑布契约：`packages/core/agent/src/runtime-types.ts`。
- 仅归因来源种类：`dsh-llm` 的 `MessageSourceMap` 中的 `@persistenceAttribution` 约定。
- 同种提供者风格的受约束指令加载：`@deepseek-ai/dsh-agent-instructions`。

<a id="model-experience"></a>
## 模型体验

### 记忆笔记

#### 模型看到什么

若存在记忆文件，每个步骤的消息批次携带一条 `user` 消息，按层与路径标注——`--- BEGIN PROJECT MEMORY (MEMORY.md) ---`——包含笔记文本与结束标记，前置简短指示，要求优先采信这些已记录事实而非猜测。层按用户在前、项目在后的顺序在同一消息内渲染。

#### Token 影响

笔记文本按其 `user/message` 内容精确计数；仅归因来源不增加超出消息信封的序列化 token。探测与读取受 fs 预算而非模型预算约束：token 成本只随实际注入的字符增长，上限 `maxChars`。

#### KV 缓存影响

笔记经由标准用户消息路径进入，KV 缓存行为遵循基础对话：除一条笔记消息外不创建额外上下文块。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 无后台提取：本插件只读取用户或其他插件写好的笔记；从对话轮次自动提取属于未来的记忆服务。
- 无逐文件预算：单一 `maxChars` 约束整条笔记；超出预算的文件被截断而非单独调整大小。
- 无文件监视：新鲜度来自每次 pre-step 重读，对小笔记开销低，但每步都会重读。
- 无过期用户笔记的删除：移除是文件系统操作，不是插件策略。

<a id="dev-note"></a>
### 开发备注

本包遵循上下文包惯例：零保留会话状态、通过 `ctx.fs` 做提供者读取、导出纯函数 `applyPreStepMemory` 供 `agent/pre-step` 监听器委托，使瀑布接线保持轻薄，核心逻辑可直接测试。