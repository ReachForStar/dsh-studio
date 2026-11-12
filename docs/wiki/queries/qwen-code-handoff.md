---
title: qwen-code 采纳工作交接
type: query
tags: [交接, qwen-code, 路线图, 未完成项]
created: 2026-11-11
updated: 2026-11-12
sources: []
status: active
---

# qwen-code 采纳工作交接

## 一句话总结

对照 `github.com/QwenLM/qwen-code`（`tmp/qwen-code`，检出 `6a999b20b7`）评估 dsh 的可采纳能力，已落地 9 个交付（Agent Plugins v1、工具检索、worktree 脏状态镜像、逐工具上下文成本、记忆注入、工具批次摘要、下一步建议、推测门控与 overlay、推测触发）。剩余 2 项（通道运行时、Arena 本体）需要核心接缝或多会话编排，留给后续会话。

## 已完成交付

| 项 | 位置 | 状态 |
| --- | --- | --- |
| 能力对比评估 | [qwen-code 能力对比](qwen-code-capability-comparison.md) | 已完成 |
| Agent Plugins v1 加载器 | [agent-plugins](../entities/agent-plugins.md) | 已完成 |
| 工具检索 `tool_search` | [tool-search](../entities/tool-search.md) | 已完成 |
| worktree 脏状态镜像 | [worktree 脏状态镜像](../entities/worktree-dirty-mirror.md) | 已完成（`mirrorMaxFileBytes` 默认 20 MiB） |
| 上下文成本逐项 | `packages/llm/token-meter` 的 `contextBreakdown`：`idleCostTokens` + 逐工具 `tools`，stateVersion 8 | 已完成 |
| 记忆注入 | [memory-notes](../entities/memory-notes.md) | 已完成 |
| 工具批次快模型摘要 | [step-summary](../entities/step-summary.md) | 已完成 |
| 下一步建议 | [followup](../entities/followup.md) | 已完成 |
| 推测执行门控 + overlay 代理 | [speculation](../entities/speculation.md) | 已完成 |
| 推测触发（预测 + 预执行 + 提交/丢弃） | [speculation](../entities/speculation.md) | 已完成（`@deepseek-ai/dsh-speculation/runner`） |

## 未完成项与开工点

### 1. 通道运行时

现状：`packages/experimental/webhook` 只把外部事件转成**新 Session**；qwen 的 channels 能把事件投递到**活跃会话**。

核心缺口已缩小：`Agent` 接口已有 `followup(message)` / `send(message, target, wakeup)` / `steer(message)`，把一条 `UserMessage` 投递到已存在的会话并唤醒驱动不需要改核心；`ctx.agents.get(sessionId)` 可取到活跃 Agent。开工时需要确认的点：

- 投递使用的消息来源种类：新增种类要按第 2 条走持久化记录，或复用现有种类。
- 会话不在运行时的处理（取不到 Agent、或需要恢复一个持久化会话）与幂等（同一外部事件重复投递）。
- 拆三角色：adapter（外部协议 → 归一事件）、routing（选择目标会话）、delivery（投递到会话）。
- 若目标会话必须存在才能投递，退化为「路由到新会话」并在 README 明确差异。

### 2. Arena 本体

现状：前置条件已具备（`create_worktree` 的 `mirrorUncommitted` 与 `mirrorMaxFileBytes`）。

开工点：

- 每模型一个 Session，并行在各自 worktree 中执行同一提示。
- 比较输出需要一条新投影（参考 [session projection](../../../.agents/skills/dsh-session-projection/SKILL.md)）；摘要类数据可参考 `step-summary` 的 log-only 事件模式。
- 胜者应用：把胜出 worktree 的 diff 应用到主工作区（写操作走正常审批路径，不要复用推测 overlay）。
- 风险：并行 Session 的生命周期、取消与资源回收；需要 e2e 证据。

## 门禁与踩坑清单（后续会话必读）

1. **新增会话事件**：`declare module '@deepseek-ai/dsh-session/types'` 扩展 `SessionEventMap`，然后必须走持久化记录流程：`pnpm run gen-persistence-catalog` → 写 `.artifacts/persistence-change.prose.json`（中英 `summary`/`compatibility`/`verification`）→ `pnpm --silent run persistence-changes --record <日期-短名> --prose <文件> --decision same-version --json`。log-only 且无 surface 操作的事件是 same-version allowed。
2. **新增消息来源种类**：`declare module '@deepseek-ai/dsh-llm'` 扩展 `MessageSourceMap`。标注 `@persistenceAttribution` 的仅归因种类是 attribution-only；带 `ContextFormed` 的种类会被判为 union-variants-changed，需要在记录里写双向兼容说明。
3. **禁止同步历史读取**：`Session.snapshotEvents()` / `eventAt()` / `ownEvents()` 已弃用，新代码必须在 `session/event` 投递中增量累积状态（`step-summary`、`followup` 都是这个模式）。
4. **包名前缀陷阱**：`gen-tool-catalog` 把 `tool-*` 包视为工具包并要求加入 `TOOL_PACKAGES`；没有工具定义的包（如 `step-summary`）必须避开该前缀。
5. **README 骨架**：每个包 README 需要 `## Summary`/`## Table of Contents`/Dev Note；`## Model Experience` 必须是最后两个 H2 之一（与 `## Known Limitations and Deferred Work`），其下是 `### <title>` + 恰好三个有序 H4（`#### What the model sees`、`#### Token effect`、`#### KV Cache effect`），且至少一个条目要有内联代码/嵌套 markdown/工具目录链接。中文版章节名用「概述」「目录」「开发备注」，TOC 锚点保持英文并在每个标题前加 `<a id="..."></a>`，否则 `verify-md-links` 失败。
6. **生成物**：新增包或配置字段后依次跑 `gen-tsconfig-paths`、`gen-plugin-packages`、`gen-config-catalog`、`gen-doc-graphs`、`verify-persistence-formats --write`、`verify-translation-pairing --write`，最后 `pnpm run doc-sync`（当前 43 项）。持久化 record 的 `--prose` 输入文件放 `tmp/`。
7. **新包必须登记进 TS 聚合**：新建包（或在既有包里新增测试文件）要手工把 `{ "path": "./packages/<组>/<包名>" }` 加进 `tsconfig.host.json` 的 `references`，否则 `pnpm run typecheck` 报 `TS6307 ... is not listed within the file list of project`。2026-11-12 已补 `agent-plugins`、`followup`、`speculation`、`step-summary`、`tool-search`。
8. **包的子路径导出要在 paths 里手写别名**：`@deepseek-ai/dsh-x/<sub>` 的 `tsconfig.base.json` 别名不在生成区，需在 `dsh-tools/pipeline` 那一片手写（本次加了 `@deepseek-ai/dsh-speculation/overlay` 与 `.../runner`），否则 README 的 `ts` 代码块过不了 `doc-typecheck`。
9. **README 两条硬约束**：`## Summary` 不超过 100 词（`verify-package-readme-summaries`）；文档里的 TypeScript 代码块会被 `doc-typecheck` 编译，不能用 `ctx.plugin(...)` 这类文档沙箱没有的 API，挂载示例用 `yaml` 的 Loader 行。
10. **重复检测**：`pnpm run duplication`（jscpd，minTokens 60）会拦住跨文件同构代码块，例如两个模块各自声明同一份 `Config` 字段；用 `z.intersect([基础 schema, 扩展 schema])` 组合而不是复制字段。
11. **wiki 引用约束**：`verify-repository-references` 禁止在 wiki 写具体 commit 哈希；`verify-package-paths` 禁止写不存在的 `packages/...` 路径（引用 qwen-code 源码时应写「qwen-code 源码的 `x.ts`」）。
12. **覆盖率门禁**：`packages/*/*/src` 逐文件 100%（statements/branches/functions/lines），大量不可达分支要靠精简实现（去掉冗余条件）而不是忽略注释。
13. **测试注意**：`tool/result` 与 `user/message` 等 surface 事件 `append` 时必须带 `{ surfaceOp: 'append' }`；`agent/pre-step` 瀑布派发要求插件注册的 ctx 与 agent 载体同属一个 harness ctx。
14. **lint 常见拦截**：`@stylistic(max-len)` 140、`eol-last`、`no-misused-spread`（对对象字面量用显式字段）、`no-unnecessary-type-assertion`、`no-confusing-void-expression`。

## 临时文件与授权

未删除，待授权：

- `.artifacts/persistence-change.prose.json`（已 gitignore，持久化记录输入）
- `tmp/persistence-check.json`（一次性检查输出）
- `tmp/persistence-prose.json`（本次推测触发的持久化记录输入）
- `tmp/task-speculation-runner.md`（本次任务清单）
- `tmp/cov/`（一次性覆盖率 JSON 报告）

`tmp/qwen-code` 是用户提供的参照仓库，必须保留。

## 相关页面

- [qwen-code 能力对比](qwen-code-capability-comparison.md)：逐项能力差异与采纳判断。
- [fork 自研包的门禁红项清单](fork-gate-debt.md)：`pnpm run lint` 的既有红项盘点，本次已清偿其中与 handoff 包相关的一批。
- [agent-plugins](../entities/agent-plugins.md) / [tool-search](../entities/tool-search.md) / [memory-notes](../entities/memory-notes.md) / [step-summary](../entities/step-summary.md) / [followup](../entities/followup.md) / [speculation](../entities/speculation.md)。