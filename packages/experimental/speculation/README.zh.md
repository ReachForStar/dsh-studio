---
description: "输入前执行的推测门控与 overlay 路径规划。"
kind: "package-reference"
---

# @deepseek-ai/dsh-speculation

[English](README.md) | 中文

## 概述

`dsh-speculation` 决定推测运行在用户提交输入前可以做什么。只读工具原样执行；策略允许写入时，文件写入被重定向到 overlay 路径；其余工具一律停止推测。本模块是纯逻辑：它判定单次调用或整份计划，并返回运行方需要施加的路径改写。它从不触碰文件系统，overlay 的创建、执行与提交由运行方负责。

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

### 配置

- `workspaceRoot` — overlay 映射的绝对工作区根。
- `overlayRoot` — 接收推测写入的绝对 overlay 根。
- `allowWrites` — 写入是否可重定向到 overlay。默认 `false`：没有显式开启时，任何推测写入都不执行。
- `readOnlyTools` / `writeTools` — 工具分类覆盖；留空时使用内置集合。
- `pathArgumentKeys` — 携带文件路径的参数键；留空时使用 `file_path`、`path`、`directory`。

<a id="understand-the-implementation"></a>
## 理解实现

`gateToolCall` 返回 `allow`、`redirect`（带参数键与 overlay 路径）或 `boundary`（带原因）。`overlayPath` 只在路径仍位于工作区内时把它映射到 overlay；越界路径变成 boundary。`gatePlan` 对整份预测计划套用同一规则，并保留第一个 boundary 之前的所有步骤。

门控刻意保守：写入需要 `allowWrites`，未知工具是 boundary，外部网络工具无论配置如何都在固定 boundary 集合中。

<a id="further-exploration"></a>
## 进一步探索

- 上游参考实现：qwen-code 源码的 `followup/speculationToolGate.ts`。
- 运行方需要代理的文件提供者抽象：`@deepseek-ai/dsh-fs`。
- 同门类的展示数据包：`@deepseek-ai/dsh-step-summary`、`@deepseek-ai/dsh-followup`。

<a id="model-experience"></a>
## 模型体验

### 推测门控

#### 模型看到什么

什么也没有。本包不发起请求、不记录事件；它只对推测运行方已经产出的工具调用做分类。

#### Token 影响

0 token：门控是完全本地的同步逻辑。

#### KV 缓存影响

没有影响：不涉及任何模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 无 overlay 文件系统：本包只规划路径；从 overlay 提供读取、接受后提交的代理 `FileSystem` 实现延后。
- 无预测：从用户意图生成推测计划属于运行方。
- 无提交步骤：把 overlay 内容移回工作区由运行方负责。
- 无 shell 门控：未实现命令安全分类；shell 调用一律 boundary。

<a id="dev-note"></a>
### 开发备注

门控是纯函数，运行方无需执行任何操作即可测试其安全策略。
