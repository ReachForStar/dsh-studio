# 星域（星域角色路由）

[English](xingchen.md) | 中文

星域给一个会话四个角色。启明是原生编码代理——harness 自己的代理，路由纪律写在它的预设人设里。天权、瑶光、天梁是专家席位：架构评估与代码审查、疑难 Bug 复现与根因、版本规划与分波交付；席位默认在本进程内以子代理运行，也可改为走部署配置的 [A2A](a2a.zh.md) 对等端。本包提供委派工具、三个斜杠命令、路由提示词段落，以及会话列表读取角色与终止原因标签所用的 `xingchen` 会话投影。

Source: [`packages/xingchen/xingchen/src/index.ts`](../../packages/xingchen/xingchen/src/index.ts)

## 角色与提示词隔离

专家是席位，不是后端。席位默认本机运行：派发经 `ctx.subagents` 起一个子代理，并在任务前附加该角色的章程，因此子代理按该角色的人设与纪律工作。席位配置为 `mode: a2a` 时，同一段文本发给外部代理（Pi、Claude Code 或 OpenCode 部署），端点由部署配置；定义角色的仍是席位。启明的章程是 `xingchen-qiming` 代理预设的人设，只在该预设内替换部署默认值。

章程是包内文本（`charters.ts`），可按角色经 `charters` 覆盖，部署无需改动本包即可调整某个角色的提示词。

## 路由

三条路径都能抵达专家，三条都会写日志，也都汇入投影：

- `xingchen_route` 工具。请求明确属于某位专家时，路由代理调用它。任务必须自包含：远端专家看不到本工作区，调用方模型需要把专家所需的文件内容、diff 与上下文写进任务。
- `/review`、`/bug`、`/planning` 命令。人直接指定专家，不经过模型轮次。
- 导出的 `routeXingchen` 启发式，不用模型即可分类一条消息：行首斜杠命令直接决定；否则一个角色需要命中两个不同关键词，且得分严格高于其他所有角色。单个弱信号不会把消息从路由代理手里带走，同时命中两位专家的消息留给启明，因为拆分正是它的职责。

## 会话元数据

每次派发与每次轮次终止都会追加到 `xingchen` 会话投影：最近派发的角色、派发次数、最近一轮的终止原因（`completed`、带原因的 `aborted`、`blocked`、`error`、`max-tokens` 或 `interrupted`）。该视图未建模的轮次终止类型统一折为通用 `error` 标签，完整原因留在 `turn/end` 事件中。投影是对会话日志的折叠，随会话一起重建，不需要自己的存储。

## 内置技能

`./skills` 入口把三个技能注册进会话目录：`git`（历史、blame、定位引入缺陷的提交）、`run`（跑复现或聚焦测试并给出真实结果）、`log`（把日志或堆栈解析成能指明失败的证据）。前两个是瑶光在归因前需要的证据基础；三者对模型与人都可调用，因此可以从输入框调用 `$git`、`$run`、`$log`。

## 配置

```yaml
- name: '@reachforstar/dsh-xingchen'
```

无需配置：每个席位都经 `ctx.subagents` 起子代理。要让某个席位走远端或换模型：

```yaml
- name: '@reachforstar/dsh-xingchen'
  config:
    seats:
      yaoguang:
        model: amax/qwen-3.8-27B
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `seats.<role>.mode` | 配了对等端则 `a2a`，否则 `local` | `local` 在本进程内委派子代理；`a2a` 把任务发给配置的对等端 |
| `seats.<role>.provider` | `spawn` | `local` 席位使用的 `ctx.subagents` 提供方 |
| `seats.<role>.model` | 继承父代理 | `local` 席位的子代理模型路由，写作 `provider/model` |
| `seats.<role>.timeoutMs` | `300000` | `local` 席位的等待上限；超时即释放子运行并报错，不无限等待 |
| `peers.<role>` | `claude-code` / `pi` / `opencode` | `a2a` 席位使用的对等端 |
| `charters.<role>` | 包内章程 | 替换某个角色的章程文本 |

对等端名称必须存在于 `a2a` 行的 `peers` 映射中；没有配置端点的名称会让派发以对等端自己的错误失败，而不是静默什么都不做。

## 关联

- 包参考： [dsh-xingchen](../../packages/xingchen/xingchen/README.zh.md)
- 分组总览：[packages/xingchen](../../packages/xingchen/README.zh.md)
- 对等端接缝：[a2a.zh.md](a2a.zh.md)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxxingchen--xingchenservice"></a>

### `ctx.xingchen` — `XingchenService`

`ctx.xingchen`: the star-domain routing service.

Owns the role bindings (peer + charter), the dispatch with per-session peer-conversation continuity, the `xingchen_route` tool, the `/review` `/bug` `/planning` commands, the routing prompt section, and the `xingchen` projection registration.

```ts cordis-catalog
/**
 * Dispatch one task to a specialist role through its A2A peer, prefixing
 * the role charter and continuing the per-session peer conversation.
 * @param role - the specialist role.
 * @param task - the self-contained task text.
 * @param sessionKey - the session id owning the conversation continuity.
 * @param signal - cancellation owned by the caller.
 * @returns the peer's answer and its continuation addressing.
 */
async dispatch( role: XingchenSpecialistId, task: string, sessionKey: string, signal?: AbortSignal, ): Promise<A2APeerReply>
```

Source: [`packages/xingchen/xingchen/src/index.ts`](../../packages/xingchen/xingchen/src/index.ts)
<!-- END GENERATED cordis-surface -->
