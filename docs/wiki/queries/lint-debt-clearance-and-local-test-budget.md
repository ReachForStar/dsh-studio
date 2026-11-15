---
title: lint 红项清零与本机测试预算（2026-11-15）
type: query
tags: [lint, oxlint, 测试预算, 超时, 原生作用域, 门禁]
created: 2026-11-15
updated: 2026-11-15
sources: []
status: active
---

# lint 红项清零与本机测试预算（2026-11-15）

## 问题

`pnpm run lint` 长期留下 75 条既有红项（[fork 自研包的门禁红项清单](fork-gate-debt.md) 登记），本地全量测试还有一批用例在默认 5 秒超时下失败：`experimental/worktree`、`client-ui-forge` 的 git 夹具套件稳定超时，`workspace-changes`、`desktop/prepare-runtime-patches`、`cua-mcp`、`plugin-manager`、`ptc-runtime-node`、`memory-notes`、`http-proxy` 等在满负载时随机超时。

## 根因

**lint**：75 条分布在 27 个文件，全部是 fork 自研代码（上游同名文件无改动），集中在四类：多余的类型断言与可选链、`any` 泄漏（excalidraw 场景 API、`Object.entries` 的接口重载）、箭头函数把 void 表达式当返回值、以及废弃 API（`snapshotEvents`/`eventAt`/`stateOf`）。另有少量纯格式项（行尾换行、缩进、行宽）是合并后未跑格式修复留下的。

**超时**：git 夹具的每条命令都经由 `ctx.subprocess` 的本地运行时。在 Linux 上该运行时选中原生作用域（`linux-scope`），每次启动先把命令交给一个私有的 Node runner 引导进程（cwd/env 恢复、fd 交接、`execve`），实测约 150 毫秒/条；单个 lens 用例要跑约 180 条 git 命令，光启动开销就 25 秒以上。CI 容器里没有可用的用户作用域，走直接 spawn 路径（约 2 毫秒/条），因此同样的用例在 CI 上数秒内完成——超时是**本机宿主能力**带来的，不是断言变慢。

## 解法

**lint 按规则修正，不关闭规则**：

| 规则 | 修法 |
| --- | --- |
| `no-unnecessary-type-assertion` / `no-unnecessary-condition` | 删掉断言与多余可选链；确需收窄时显式比较字面量并让值本身带类型 |
| `no-confusing-void-expression` | 箭头函数体改成块语句；`Promise<never>` 的拒绝回调改为块体 |
| `no-unsafe-*`（`any` 泄漏） | `JSON.parse` 结果收窄成 `Record<string, unknown>`；`Object.entries` 前把接口放宽成索引签名；数组展开改用 `value is readonly unknown[]` 类型守卫 |
| `require-await` | 去掉不必要的 `async`，需要 Promise 返回时显式 `Promise.resolve(...)`；同步函数改回同步签名并去掉调用方的 `await` |
| `no-identical-functions` | 同构构造函数改为委托到既有构造函数 |
| `no-deprecated`（生产侧会话历史读） | 按[同步读取废弃决策](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)保留行级豁免并注明「迁移推迟」；测试侧直接改用投影句柄 |
| 纯格式 | 行尾换行、缩进、行宽按文件既有风格修，`--fix` 后核对没有被改坏的文件 |

**测试预算**：

- 全局：`vitest.config.ts` 给两个 inline 项目统一加 30 秒默认预算（`localTestTimeout`，放在 `laneTestBudget` 之前，覆盖层预算仍可上调），只解决进程与安装类套件的启动开销。
- 局部：`client-ui-forge` 与 `experimental/worktree` 的 git 夹具套件在文件头加 `vi.setConfig({ testTimeout: 60_000 })`，注释写明是为启动开销而非慢断言。
- 不通过 `pnpm run test -- --testTimeout=…` 传参：CLI 参数到不了 inline 项目，这条路此前被误以为可行。

**顺带修真问题**：`ui-polish` 的 `GitPanel`、`LatexPanel` 与 `PricingRow`/`CompactionRow` 把通知定时器留在组件卸载之后，jsdom 拆除后触发 `window is not defined` 未处理异常（全量测试 `Errors 1`）。三处都补了卸载清理。

## 验证

```bash
pnpm run lint                                  # 0 error
pnpm run typecheck                             # 5 门
pnpm run build:artifacts && pnpm run build:check
pnpm run test:docs                             # 21 门
pnpm exec vitest run                           # 默认配置：60692 通过 / 1 既定期望失败 / 274 跳过，0 未处理错误
```

## 复发预防

- 新增 fork 代码先跑 `pnpm run lint`（受影响目录即可），不要等到合并后再清理成片红项。
- 撤废弃 API 时，生产侧只接受「行级豁免 + 迁移推迟」这一种写法；测试侧优先读投影句柄。
- 夹具驱动真实进程时，把预算写在文件头并说明原因；不要用 CLI 参数绕过（对 inline 项目无效）。
- 组件里的 `setTimeout` 必须配卸载清理，否则 jsdom 拆除后会变成未处理异常。

## 涉及模块

- [fork 自研包的门禁红项清单](fork-gate-debt.md)：本页清偿其中的 lint 与超时两部分。
- [合并上游 upstream/master（2026-11-15）](upstream-merge-2026-11-15.md)：这些红项由该轮合并暴露。
- `packages/subprocess/subprocess-local` 的 Linux 原生作用域启动路径（超时的来源）。
- `vitest.config.ts` 的测试预算与 `client-ui-forge`/`experimental/worktree` 夹具套件。
