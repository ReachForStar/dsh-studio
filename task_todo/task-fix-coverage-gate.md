# 修复 test:coverage 的 per-file 100% 阈值

口径：先按覆盖率报告分出三类文件，再逐类处理；删除真正的死代码优先于补测试。

- [x] 里程碑：取得本轮全量覆盖率数据，列出未达标文件与缺口行
- [x] 分类：本次回退引入的缺口（agent-loop、hooks、llm、sandbox、session-persistence-*、worktree、tool-worktree）
- [x] 分类：本 fork 既有门禁红项（a2a、remote/*、cua、xingchen、pi-agent-loop、ui-paper-reader、ui-polish、session-format 分支）
- [x] 分类：仅缺单条分支或函数的文件
- [x] 处理 A 类：回退残留代码直接删除；恢复被误删的测试
- [x] 处理 B 类：无法补齐的文件登记进 `vitest.config.ts` 豁免块并记录决策
- [x] 处理 C 类：`escalation.ts` 补 action/resources 用例
- [x] 里程碑：`pnpm run test:coverage` 全绿
- [x] 回归：`pnpm run typecheck`、`lint`、`doc-sync`、`build:check` 仍通过
- [x] 更新 wiki（`queries/fork-gate-debt.md` 与本页相关页），index 与 log
- [x] 提交并推送