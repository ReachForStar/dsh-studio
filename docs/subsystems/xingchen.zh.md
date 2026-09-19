# 星域（星域角色路由）

[English](xingchen.md) | 中文

星域给一个会话四个角色。启明是原生编码代理——harness 自己的代理，路由纪律写在它的预设人设里。天权、瑶光、天梁是专家席位，经 [A2A](a2a.zh.md) 对等端抵达：架构评估与代码审查、疑难 Bug 复现与根因、版本规划与分波交付。本包提供委派工具、三个斜杠命令、路由提示词段落，以及会话列表读取角色与终止原因标签所用的 `xingchen` 会话投影。

Source: [`packages/xingchen/xingchen/src/index.ts`](../../packages/xingchen/xingchen/src/index.ts)

## 角色与提示词隔离

专家是外部代理（Pi、Claude Code 或 OpenCode 部署），端点由部署配置；定义角色的是席位，不是后端。每次派发都在任务前附加该角色的章程，因此不论席位由哪个后端占据，对等端都按该角色的章程与纪律工作。启明的章程是 `xingchen-qiming` 代理预设的人设，只在该预设内替换部署默认值。

章程是包内文本（`charters.ts`），可按角色经 `charters` 覆盖，部署无需改动本包即可调整某个角色的提示词。

## 路由

三条路径都能抵达专家，三条都会写日志，也都汇入投影：

- `xingchen_route` 工具。请求明确属于某位专家时，路由代理调用它。任务必须自包含：专家在自己的环境运行，看不到本工作区，调用方模型需要把专家所需的文件内容、diff 与上下文写进任务。
- `/review`、`/bug`、`/planning` 命令。人直接指定专家，不经过模型轮次。
- 导出的 `routeXingchen` 启发式，不用模型即可分类一条消息：行首斜杠命令直接决定；否则一个角色需要命中两个不同关键词，且得分严格高于其他所有角色。单个弱信号不会把消息从路由代理手里带走，同时命中两位专家的消息留给启明，因为拆分正是它的职责。

## 会话元数据

每次派发与每次轮次终止都会追加到 `xingchen` 会话投影：最近派发的角色、派发次数、最近一轮的终止原因（`completed`、带原因的 `aborted`、`blocked`、`error`、`max-tokens` 或 `interrupted`）。该视图未建模的轮次终止类型统一折为通用 `error` 标签，完整原因留在 `turn/end` 事件中。投影是对会话日志的折叠，随会话一起重建，不需要自己的存储。

## 配置

```yaml
- name: '@reachforstar/dsh-xingchen'
  config:
    peers:
      tianquan: claude-code
      yaoguang: pi
      tianliang: opencode
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `peers.tianquan` | `claude-code` | 承载天权的 A2A 对等端 |
| `peers.yaoguang` | `pi` | 承载瑶光的 A2A 对等端 |
| `peers.tianliang` | `opencode` | 承载天梁的 A2A 对等端 |
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
