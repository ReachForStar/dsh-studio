---
title: Arena 模型对比（dsh-arena）
type: entity
tags: [Arena, 多模型对比, worktree, 会话编排]
created: 2026-11-12
updated: 2026-11-12
sources: []
status: active
---

# Arena 模型对比（dsh-arena）

## 职责

把同一提示同时交给多个模型，每个参选者在一个从同一提交分出的 Git worktree 中跑完整一轮，返回可比较的结果；被选中的参选者改动由调用方显式应用到主工作区。运行本身从不写 `workspaceRoot`。

## 关键文件

- `packages/experimental/arena/src/index.ts`：`ArenaService`（`ctx.arena`）。`run(request, { signal })` 建 worktree 与会话并等待全部收敛；`apply(runId, label)` 应用某参选者 diff；`remove(runId)` 清理 checkout 与分支；`runs()` 列出保留中的运行。比较数据来自 `session/event` 投递（`turn/start`、`tool/call`、`assistant/message`），不读历史。
- `packages/experimental/arena/src/git.ts`：`runGit` 经 `subprocess` + `sandbox` 按 `sandboxPolicy` 解析出的策略执行，清除仓库选择变量；`addWorktree` / `changedPaths` / `writePatch` / `applyPatch` / `removeWorktree` 封装所需命令。
- `docs/subsystems/arena.md`：服务面的对外说明（含生成的 Cordis API 区）。

## 设计决策

- **每参选者独立检出**：比较衡量的是模型本身，不是它们共享工作树的能力。`worktreeRoot` 必须位于 `workspaceRoot` 之外，避免比较用的检出落在被应用改动的工作区里。
- **运行与接受分离**：`run()` 只产出结果，`apply()` 才写主工作区。推测执行的 overlay 不复用——Arena 的写是用户显式接受的一次真实写入，不需要 overlay 的第二层抽象。
- **diff 收集先暂存**：读 diff 前先 `git add --all`，再 `git diff --cached <base>`，因此从不提交的模型也能给出完整改动集（含新增文件）；补丁写出时补回结尾换行，否则 `git apply` 判定损坏。
- **失败不拖垮整次运行**：单个参选者失败或被取消只体现在自身 `status`（`failed` / `cancelled`）与 `failure` 文本；会话释放失败、worktree 删除失败只记日志。
- **参选者会话收敛后释放**：只保留持久化日志作为过程证据，避免长期占用活跃 Agent。

## 与 qwen-code 的差异

qwen 的 Arena 内建比较摘要（按 diff 的思路描述）与界面；本实现只返回回复文本、状态、耗时、轮次、工具调用数、token 与改动路径，摘要与视图留给后续（见「待确认」）。qwen 在自身 `ArenaManager` 里管 worktree 生命周期；这里把 git 操作集中到 `git.ts` 并经沙箱执行。

## 验证

24 个测试（`git.spec.ts` 8 个用真实临时仓库覆盖命令成功/失败/输出截断/取消、worktree 增删、diff 收集与应用；`arena.spec.ts` 16 个用脚本化 Agent 注册表覆盖并行执行、指标累积、应用与清理、单参选者失败/取消、请求校验与配置校验），src 逐文件 100%（语句 182/182、分支 100/100、函数 31/31、行 159/159）；lint、`jscpd` 0 克隆、`pnpm run typecheck`、`doc-sync` 43 项通过。新增 `dsh-arena` 来源种类，持久化记录 `2026-11-12-arena`（same-version）。

## 待确认

- 没有比较摘要（谁在哪方面更好）与界面；数据靠调用方自行比较。
- `apply()` 不跑测试、不请求审批、不检测与运行开始后新改动的冲突。
- 参选者不设 preset；工具面由部署级挂载决定。
- 运行保留 checkout 直到 `remove()`，从不清理的部署会累积目录。
