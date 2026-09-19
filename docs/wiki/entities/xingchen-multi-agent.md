---
title: 星域多智能体协作（dsh-xingchen）
type: entity
tags: [星域, 多智能体, 路由, a2a, preset, 会话投影, fork 扩展]
created: 2026-09-19
updated: 2026-09-19
sources: []
status: active
---

# 星域多智能体协作（dsh-xingchen）

fork 自研的四角色协作系统，位于 `packages/xingchen/xingchen`（包名 `@reachforstar/dsh-xingchen`）。设计取舍见[专家席经 A2A 抵达的决策](../decisions/2026-09-19-xingchen-external-specialist-seats.md)，实现期缺陷与门禁接线见[排查页](../queries/xingchen-review-fixes.md)。子系统参考页是 `docs/subsystems/xingchen.md`（含生成的 `ctx.xingchen` API）。

## 四个角色

| 角色 | 归属 | 职责 |
| --- | --- | --- |
| 启明 | 本仓原生编码代理（预设人设） | 默认路由器；日常编码、重构、单测、脚本、文档 |
| 天权 | A2A 专家席位 | 架构评估与代码审查（多维权衡、版本化审查结论） |
| 瑶光 | A2A 专家席位 | 疑难 Bug 复现与根因（强制证据收集、缺陷归族） |
| 天梁 | A2A 专家席位 | 版本规划与分波交付（任务卡片、里程碑、风险） |

代理席位的后端由部署配置（默认 `claude-code` / `pi` / `opencode`），角色由派发时附加的章程定义，因此换后端不改角色语义。

## 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | `XingchenService`：角色绑定、派发与按会话续接、`xingchen_route` 工具、三个命令、路由提示词段落、投影注册 |
| `src/route.ts` | 角色名/简介、命令↔角色映射、`roleOfCommand`（日志边界校验）、`routeXingchen` 启发式 |
| `src/charters.ts` | 三位专家的章程文本 |
| `src/clear.ts` | 独立入口 `./clear`，挂在预设压缩分组内（复用该域的 `ctx.compaction`） |
| `src/types.ts` | 领域类型与 `SessionProjectionMap` 声明合并 |

## 派发三条路径

- `xingchen_route` 工具：路由代理判定任务属于专家时调用；任务必须自包含（专家在自己的环境，看不到本工作区）。
- `/review`、`/bug`、`/planning` 命令：人直接指定专家，不经过模型轮次（`dispatchCommand` 把对等端错误落定为命令错误结果，不抛出）。
- `routeXingchen` 启发式：行首斜杠命令直接决定；否则需两个以上不同关键词命中且得分严格最高者胜出，平局与单信号留给启明。

## 会话投影

`xingchen` 投影折叠 `command/run`（`roleOfCommand` 查表）、`tool/call`（`xingchen_route`）与 `turn/end`，产出 `{ lastRole, dispatchCount, lastTurnReason }`；未建模的 `turn/end` 类型折为通用 `error`。投影是日志折叠，随会话重建，不单独落盘。

## 接线位置

- 预设：`packages/preset/agent-presets/presets/standard/agent.cordis.yml`（默认组合加入星域行与 `/clear`）与 `presets/xingchen-qiming/`（同组合、启明人设）。星域行包在 `cordis:group` + `isolate: { xingchen: true }` 里：该行提供 `ctx.xingchen`，发布到根 isolate 会被 `mountPreset` 判为进程级服务泄漏而拒给会话用（详见[排查页](../queries/xingchen-review-fixes.md#预设激活失败服务未在-isolate-域内网页冒烟才发现)）。
- 解析清单：`apps/cli/package.json`、`packages/bundle/web-app/package.json`（预设挂载在 web-app bundle，插件按该清单解析）。
- 类型项目：`tsconfig.host.json` 引用；`tsconfig.base.json` 手写 `@reachforstar/dsh-xingchen` 别名（生成器只覆盖 `@deepseek-ai/dsh-` 前缀）。
- 文档图：`scripts/gen-cordis-catalog.ts` 的 `SERVICE_PAGE`/`LINK_MAP` 与 `scripts/gen-doc-graphs.ts` 的 `SERVICE_ROLES`（fork 包不在扫描范围内，用仓库路径 `xingchen/xingchen` 作 owner 标签）。

## 上游依赖

- `ctx.a2a`（[A2A 栈](a2a-stack.md)）：出站派发的对等端接缝；`contextId` 即会话 id，因此按 `会话 id + 角色` 记住 `contextId` 即可续接对等端会话。
- `ctx.sessionProjections`、`ctx.tools`、`ctx.systemPrompt`、`ctx.commands`（可选注入）、`ctx.compaction`（仅 `./clear`）。

## 待确认

- 本机网页冒烟已验证：选星域预设后会话的系统提示词含启明人设与「## 星域协作」段落，请求头工具表 49 个工具含 `xingchen_route`。
- `branch`（分支）与 `working`（执行中）两项会话元数据尚未进入投影：前者不是日志事件（需在读侧从工作区取），后者与既有会话运行状态重复，尚无消费方。
- `#会话` 引用与前端「星域路由切换」未实现；会话列表目前也没有消费 `xingchen` 投影的界面。
- 第二、三阶段（`$git`/`$run`/`$log` 技能、缺陷归族与跨会话知识库）未开始。
