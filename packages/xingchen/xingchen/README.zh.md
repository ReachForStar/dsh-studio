---
description: "给一个会话四个星域角色：在天权/瑶光/天梁 A2A 专家席位上按各自章程委派、由启明处理日常开发，并给会话打上角色与终止原因标签。"
kind: "package-reference"
---

# @reachforstar/dsh-xingchen

[English](README.md) | 中文

## 概述

`dsh-xingchen` 给一个会话四个星域角色。启明是 harness 自己的编码代理，也是默认路由器；天权（架构评估与代码审查）、瑶光（疑难 Bug 复现与根因）、天梁（版本规划与分波交付）是专家席位：默认在本进程内以子代理运行，部署配置了对等端时可改为走 A2A。路由代理通过 `xingchen_route` 工具委派，人用 `/review`、`/bug`、`/planning` 直接指定专家，每次派发都附加该角色的章程，因此定义角色的是席位。`xingchen` 会话投影提供会话列表的角色与终止原因标签。

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

在代理预设里挂载；挂在宿主组合里会让工具、命令与提示词段落整个进程只注册一次，而投影是按会话的。`packages/preset/agent-presets/presets/standard/agent.cordis.yml` 挂载了本包，`xingchen-qiming` 是同一套组合但人设换成启明。

### 何时选用

当工作应当交给另一个代理、按另一套纪律完成时选择它——架构评审、需要先复现再诊断的 Bug、交付计划。每个席位默认本机运行，无需额外部署；当某个角色应放到另一个代理部署上运行时，把该席位的 `mode` 设为 `a2a`。当模型自己应当按名称在多个对等端之间选择时，改用 [dsh-tool-a2a](../../a2a/tool-a2a/README.zh.md)；本包拥有四角色划分、章程与会话标签，`a2a` 席位用的正是那个包的接缝。

### 最小配置

无需配置：每个席位经 `ctx.subagents`（默认 `spawn`）起一个子代理，并前置该角色的章程。

```yaml
- name: '@reachforstar/dsh-xingchen'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `seats.<role>.mode` | `local` | `local` 在本进程内委派子代理；`a2a` 把任务发给配置的对等端 |
| `seats.<role>.provider` | `spawn` | `local` 席位使用的 `ctx.subagents` 提供方 |
| `seats.<role>.model` | 继承父代理 | `local` 席位的子代理模型路由，写作 `provider/model` |
| `seats.<role>.timeoutMs` | `300000` | `local` 席位的等待上限；超时即释放子运行并报错，不无限等待 |
| `peers.<role>` | `claude-code` / `pi` / `opencode` | `a2a` 席位使用的对等端，须存在于 `a2a` 行的 `peers` |
| `charters.<role>` | 包内章程 | 替换某个角色的章程文本 |

<a id="understand-the-implementation"></a>
## 理解实现

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `XingchenService`：角色绑定、带按会话对等端连续性的派发、`xingchen_route` 工具、三个命令、路由提示词段落、投影注册 |
| [`src/route.ts`](src/route.ts) | 角色名称、简介、命令到角色的映射，以及不用模型的 `routeXingchen` 分类器 |
| [`src/charters.ts`](src/charters.ts) | 三位专家的章程（人设与工作纪律） |
| [`src/skills.ts`](src/skills.ts) | `./skills` 入口：从本包资源注册内置 `git`/`run`/`log` 技能 |
| [`src/clear.ts`](src/clear.ts) | `/clear` 命令，挂在预设的压缩分组内 |
| [`src/types.ts`](src/types.ts) | 纯领域类型与 `SessionProjectionMap` 合并 |

### 导出形状

模块导出 `name`、`Config`、服务与 `apply`，**没有默认导出**：Loader 的 `unwrapExports` 会吃掉带默认导出的模块，加载时静默丢掉 `inject` 与 `Config`（见[事故记录 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。`./clear` 是第二个入口，带自己的 `name`、`inject`、`apply`，因为 `/clear` 必须与挂载它的预设共用压缩域。

### 派发与续接

一次派发把角色章程、分隔线与任务作为一条消息发出。`local` 席位经 `ctx.subagents` 起一个子代理并返回它的最终消息；子代理是独立会话，因此一次评审或一次复现会像其他委派一样出现在会话列表里。`a2a` 席位把同一段文本发给对等端，并按 `会话 id + 角色` 记住应答的 `contextId`，因此同一角色的第二次派发续接对等端会话，另一个角色则开启自己的会话。对等端续接是进程内的：对等端的历史能挺过重启，这张映射不能。

### 会话投影

`xingchenProjectionDefinition` 把三类事件折叠为 `{ lastRole, dispatchCount, lastTurnReason }`。指名角色命令的 `command/run`，或带可识别角色的 `xingchen_route` 的 `tool/call`，记录角色并递增计数；`turn/end` 记录裁剪后的终止原因。参数异常的日志条目保持状态不变而不是让折叠失败，因为投影要重放日志里存的任何内容。

<a id="further-exploration"></a>
### 内置技能

`./skills` 入口把三个内置技能注册进会话的技能目录：`git`（读历史、blame、定位引入缺陷的提交）、`run`（跑复现或聚焦测试并报告真实结果）、`log`（把日志或堆栈解析成能指明失败的证据）。三者对模型与人都可调用，因此 `$git`、`$run`、`$log` 在输入框里可用，路由代理也能按名字加载。每个技能以 `skills/<name>/SKILL.md` 随本包资源发布；打包安装时可用 `assetRoot` 指向别的目录。

## 进一步探索

- [星域子系统页](../../../docs/subsystems/xingchen.zh.md) —— 角色与投影说明旁的生成式 `ctx.xingchen` API。
- [A2A 栈](../../a2a/README.zh.md) —— 本包派发所经的对等端接缝。
- [代理预设](../../preset/agent-presets/README.zh.md) —— `xingchen-qiming` 与 `standard` 如何组合本包。

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型所见

`xingchen:routing` 提示词段落（与计划策略同序）列出四个角色以及何时调用 `xingchen_route`；路由代理自己的人设来自预设，不属于本包。`xingchen_route` 工具模式暴露 `role`（三个专家 id 之一）与 `task`，描述里写明专家看不到本工作区、且调用会等待专家结束。确切的模式见生成的[工具目录](../../../docs/tool-catalog.zh.md)。对等端的回答以工具结果文本返回，前面加上角色的中文名。

#### Token 影响

该提示词段落给该预设上每个会话的每次请求都加上一段固定文本。技能目录另有一段提醒，逐条列出每个内置技能的描述。一次派发加上自己的 JSON 参数与对等端的完整回答；回答不做摘要，因此很长的专家报告会以完整长度占用调用方上下文。

#### KV Cache effect

提示词段落文本与工具模式按部署固定，因此都不会让可复用的前缀失效。命令不注册自己的提示词文本。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **专家席位默认本机，`a2a` 需要已配置的对等端。** `local` 席位在本进程内起子代理，因此需要 `subagents` 注册表与已注册的提供方。使用 `mode: a2a` 而没有配置对等端的部署用不了天权/瑶光/天梁，每次派发都以对等端错误失败。
- **续接是进程内的。** `a2a` 席位的 `会话 id + 角色` 到 `contextId` 映射放在内存里，重启后即便对等端还持有旧会话，也会开始新的对等端会话。`local` 席位不需要这张映射：每次派发就是一个子会话。
- **一次调用只派发一个任务。** `xingchen_route` 只在专家结束时返回；很长的评审会阻塞调用轮次，专家输出也不会分段流回。
- **启发式仅供参考。** `routeXingchen` 不用模型即可分类，但真正派发的只有路由代理的工具调用与斜杠命令，目前还没有客户端或宿主路径消费该分类器。
- **没有缺陷归族历史。** 瑶光章程要求专家维护的「季节回归」关联属于专家自己的记录，本包不保存跨会话的缺陷族。

<a id="dev-note"></a>
### 开发备注

路由设计——三个经 A2A 抵达的外部席位，而不是三个随包发布的本地预设——以及投影的角色/终止原因形态记录在[星域子系统页](../../../docs/subsystems/xingchen.zh.md)。
