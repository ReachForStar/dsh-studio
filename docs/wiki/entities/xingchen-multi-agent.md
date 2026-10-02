---
title: 星域多智能体协作（dsh-xingchen）
type: entity
tags: [星域, 多智能体, 路由, a2a, preset, 会话投影, fork 扩展]
created: 2026-09-19
updated: 2026-10-02
sources: []
status: active
---

# 星域多智能体协作（dsh-xingchen）

fork 自研的四角色协作系统，位于 [`packages/xingchen/xingchen`](../../../packages/xingchen/xingchen/README.zh.md)（包名 `@reachforstar/dsh-xingchen`）。当前专家席支持本地子代理与 A2A 对等端；早期外部席位取舍见[专家席经 A2A 抵达的决策](../decisions/2026-09-19-xingchen-external-specialist-seats.md)，实现期缺陷与门禁接线见[排查页](../queries/xingchen-review-fixes.md)，界面可用性与普通消息失败见[本次排查](../queries/xingchen-usability.md)。[子系统参考页](../../subsystems/xingchen.md)含生成的 `ctx.xingchen` API。

## 四个角色

| 角色 | 归属 | 职责 |
| --- | --- | --- |
| 启明 | 本仓原生编码代理（预设人设） | 默认路由器；日常编码、重构、单测、脚本、文档 |
| 天权 | 本地或 A2A 专家席位 | 架构评估与代码审查（多维权衡、版本化审查结论） |
| 瑶光 | 本地或 A2A 专家席位 | 疑难 Bug 复现与根因（强制证据收集、缺陷归族） |
| 天梁 | 本地或 A2A 专家席位 | 版本规划与分波交付（任务卡片、里程碑、风险） |

角色由派发时附加的章程定义，席位运行方式由部署配置决定。`XingchenService` 在挂载时读取 `ctx.a2a.list()`：角色绑定的对等端存在时默认 `a2a`，不存在时默认 `local`；显式 `seats.<role>.mode` 优先。默认对等端名称依次为 `claude-code`、`pi`、`opencode`，这些名称不意味着网关已经配置或启动。

## 席位运行方式

- `local` 经 `ctx.subagents.start()` 派发，默认 provider 为 `spawn`，模型继承父代理；每次派发产生独立子会话。`seats.<role>.model` 可指定 `provider/model`，`timeoutMs` 默认 `300000`，超时释放子运行并报错。
- `a2a` 经 [A2A 服务](a2a-stack.md)派发，要求角色绑定的对等端实际存在于宿主配置；天权默认 skill 为 `code-review`，瑶光与天梁为 `analysis`。`direct` 等待回答，`bus` 等待终态事件；失败不会自动改用本地席位。
- 随包基础组合的 `a2a` 行没有 `peers` 或 `bridge`，启明预设也没有席位覆盖；只使用这些随包配置时，三个专家席均为 `local`。启明的普通消息先运行父代理模型请求，只有 `xingchen_route` 工具或专家命令才派发专家任务。

## 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | `XingchenService`：角色绑定、派发与按会话续接、`xingchen_route` 工具、三个命令、路由提示词段落、投影注册 |
| `src/route.ts` | 角色名/简介、命令↔角色映射、`roleOfCommand`（日志边界校验）、`routeXingchen` 启发式 |
| `src/charters.ts` | 三位专家的章程文本 |
| `src/clear.ts` | 独立入口 `./clear`，挂在预设压缩分组内（复用该域的 `ctx.compaction`） |
| `src/skills.ts` | 独立入口 `./skills`：从包内 `skills/<name>/SKILL.md` 注册 `git`/`run`/`log` 三个内置技能（provider `dsh-xingchen`，rank 取 `BUNDLED_SKILL_RANK`） |
| `src/types.ts` | 领域类型与 `SessionProjectionMap` 声明合并 |

## 派发入口与分类器

- `xingchen_route` 工具：路由代理判定任务属于专家时调用；任务必须自包含，远端席位看不到本工作区，需要附上相关文件内容、diff 与上下文。
- `/review`、`/bug`、`/planning` 命令：人直接指定专家，不经过父代理模型轮次；`dispatchCommand` 把派发失败落定为命令错误结果，本地专家仍要运行自己的模型轮次。
- `routeXingchen` 启发式：行首斜杠命令直接决定；否则需两个以上不同关键词命中且得分严格最高者胜出，平局与单信号留给启明。该分类器没有自动派发入口，普通消息不会仅因关键词命中就生成专家任务。

## 进度上报（2026-09-22）

A2A 席位派发期间，对端的流式输出会实时写入会话，页面不再只显示「执行中…」：

- **会话事件** `xingchen/dispatch-progress`（log-only，不进模型请求，不随轮次投影）：`{ role, callId?, commandId?, agent, skill, mode, state?, text }`。工具路径带 `callId`（`xingchen_route` 的调用 id），命令路径带 `commandId`（`/review` 等命令 id）；客户端按这两个 id 把最新一条报告折进对应卡片。
- **节流**（`src/index.ts` 的 `progressReporter`）：状态变化或文本增量 ≥200 字符立即上报；否则距上次上报 ≥2.5s 才报；结算时强制补报一次终态。本机席位不产生进度事件（子代理自己的会话事件已有独立展示）。
- **失败映射**：`dispatchCommand` 判定「席位未回答」的状态集从 A2A 终态（`TASK_STATE_FAILED` 等）扩到本机席位结果态 `failed`/`killed`——之前本机席位失败会被拼成「天梁 已处理：\n\nerror」的成功结果。
- **客户端渲染**：事件类型声明合并在 `src/types.ts`（`./client` 面可见，ui-chat 的 Definition 经 `import type {} from '@reachforstar/dsh-xingchen/client'` 引入）；`ui-conversation` 的 `CommandNode`/`RunningToolCall` 增可选 `liveProgress`；`ui-chat` 的 command/tool Definition 按 commandId/callId 把最新一条报告折进对应节点；`GenericCommandCard` 运行时在对端累计文本下展示尾部 ≤400 字符的实时预览（locale `command.progress`），`ui-tool` 行模型运行期用进度文本占位 output。

## 内置技能

`./skills` 入口把三个技能注册进会话技能目录（`source: bundled`，模型与人均可调用）：`git`（历史/blame/定位引入缺陷的提交，只用只读命令）、`run`（最小复现与聚焦测试，一次改完再跑、收集全部失败项）、`log`（日志与堆栈解析，取最内层应用帧与触发行）。`$` 触发下的 `$git`、`$run`、`$log` 即来自这个目录；技能配置只有 `assetRoot`（打包安装时指向外部资源目录），且因为它不是包主入口，`gen-config-catalog` 不会收录（生成器只扫 `src/index.ts`）。

## 会话投影

`xingchen` 投影折叠 `command/run`（`roleOfCommand` 查表）、`tool/call`（`xingchen_route`）与 `turn/end`，产出 `{ lastRole, dispatchCount, lastTurnReason }`；未建模的 `turn/end` 类型折为通用 `error`。投影是日志折叠，随会话重建，不单独落盘。

## 接线位置

- 预设：[`standard.patch.yml`](../../../packages/bundle/web-app/presets/standard.patch.yml)与 [`xingchen-qiming.patch.yml`](../../../packages/bundle/web-app/presets/xingchen-qiming.patch.yml)随 web-app bundle 发布；两者都加入星域行、`skill-xingchen` 与 `/clear`，后者使用启明人设。旧 `packages/preset/agent-presets/presets/` 路径已不存在。星域行包在 `cordis:group` + `isolate: { xingchen: true }` 里：该行提供 `ctx.xingchen`，发布到根 isolate 会被预设挂载检查判为进程级服务泄漏而拒给会话用（详见[排查页](../queries/xingchen-review-fixes.md#预设激活失败服务未在-isolate-域内网页冒烟才发现)）。
- 宿主 A2A：[`base/cordis.patch.yml`](../../../packages/bundle/base/cordis.patch.yml)提供出站 `a2a` 服务；[`web-app/cordis.patch.yml`](../../../packages/bundle/web-app/cordis.patch.yml)的 `a2a-host` 提供入站监听。入站监听状态不能用于判定本地星域席位是否可用。
- 解析清单：`apps/cli/package.json`、`packages/bundle/web-app/package.json`（预设挂载在 web-app bundle，插件按该清单解析）。
- 类型项目：`tsconfig.host.json` 引用；`tsconfig.base.json` 手写 `@reachforstar/dsh-xingchen` 别名（生成器只覆盖 `@deepseek-ai/dsh-` 前缀）。
- 文档图：`scripts/gen-cordis-catalog.ts` 的 `SERVICE_PAGE`/`LINK_MAP` 与 `scripts/gen-doc-graphs.ts` 的 `SERVICE_ROLES`（fork 包不在扫描范围内，用仓库路径 `xingchen/xingchen` 作 owner 标签）。

## 上游依赖

- `ctx.a2a`（[A2A 栈](a2a-stack.md)）：解析已配置的对等端与出站派发；`contextId` 即会话 id，因此按 `会话 id + 角色` 记住 `contextId` 即可续接对等端会话。
- `ctx.subagents`：本地席位使用的提供方注册与子代理运行。
- `ctx.sessionProjections`、`ctx.tools`、`ctx.systemPrompt`、`ctx.commands`（可选注入）、`ctx.compaction`（仅 `./clear`）。

## 会话引用与限制

- `#会话` 引用已由 `ui-reference` 的 `session-reference` 来源注册，只列会话，插入规范提及 `@[label](dsh-session:…)`；`ui-input-trigger` 的 `TriggerChar` 包含 `#`。
- `branch`（分支）与 `working`（执行中）：前者不是会话事件（只在读侧从工作区 git 状态取），后者与既有会话运行状态重复（会话列表已自行显示「进行中」），两者都没有加进投影。
- `$git`、`$run`、`$log` 已有技能资源与预设注册；本包不保存跨会话的缺陷归族历史。
- 前端「星域路由切换」与 `xingchen` 投影的界面消费情况待核验；2026-10-02 的普通消息失败与预设入口隐藏分别见[可用性排查](../queries/xingchen-usability.md)。
