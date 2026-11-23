# 合并上游 upstream/master（2026-11-18，0.2.3-alpha.2 同步）

起点：`develop` 尖端为上一轮 pi 能力落地提交，merge-base 为上游 0.2.2-rc.3 发布合并。
目标：`upstream/master` 尖端为 0.2.3-alpha.2 发布合并，1753 个上游提交、5436 个上游改动文件、1011 个与 fork 重叠文件。

口径沿用既有决策（[合并上游](../docs/wiki/decisions/2026-09-upstream-sync.md)）：全量合并、按来源逐文件取舍、生成物一律重生成、跨包 API 以上游为准。

## 门禁结果

- 通过：`typecheck`（5）、`build:artifacts`（8）、`build:check`（2）、`test:docs`（21）、全量单测（64276 通过 / 1 项既定期望失败 / 278 跳过）、`hygiene` 24/27。
- `hygiene` 余 3 项为 fork 既有债务（a2a unknown casts 9 处、`deploy/a2a` 空 catch 3 处、8 个 fork 包入口导出 25 项），已登记到 [fork 自研包的门禁红项清单](../docs/wiki/queries/fork-gate-debt.md)。

## 里程碑

- [x] 里程碑：`git merge upstream/master` 完成，冲突逐文件按来源取舍，工作树无未解决冲突
  - 完成：
  - 判据：`git status` 无 `UU/AA/DU` 条目；`grep -c '<<<<<<<'` 全树为 0。
- [x] 里程碑：fork 自研功能全部保留（pi 后端、SSH/SFTP、ui-polish、excalidraw、AM3 网关、codemode、git 检查点、input-handled、stats-float、工具检索、论文阅读器、星域等）
  - 完成：
  - 判据：对照 `git diff --name-only merge-base develop` 的 3028 个 fork 改动文件，逐个确认差异未丢失（被删的仅限上游同步删除或已判定废弃）。
- [x] 里程碑：lockfile 与生成物重生成，`pnpm install` 通过
  - 完成：
  - 判据：`pnpm-lock.yaml` 取上游后重新解析；`docs/config-catalog.*`、`event-producer-consumer.*`、`module-graph.*`、`persistence-catalog.*`、`tool-catalog.*`、`slot-catalog.ts` 由 `gen-*` 重跑产出。
- [x] 里程碑：`pnpm run typecheck` 全过
  - 完成：
  - 判据：5 个门禁全绿，fork 自研包适配上游新增/变更的跨包 API。
- [x] 里程碑：`pnpm run build:artifacts` + `pnpm run build:check` 全过
  - 完成：
- [x] 里程碑：`pnpm run test` 全量运行，失败项一次收集后集中修复并复跑转绿（本机性能类除外且需单独证据）
  - 完成：64276 通过、1 项既定期望失败、278 跳过；首轮 47 个失败文件 → 逐个判定为「测试按 fork 语义适配」或「合并引入的真实缺陷」
- [x] 里程碑：`pnpm run test:docs` 全过（含双语配对、持久化格式引用、链接与换行门禁）
  - 完成：21 门全过
- [x] 里程碑：wiki 沉淀完成（本轮合并 query 页 + 既有决策页续轮 + `index.md` + `log.md`），相对链接有效
- [x] 里程碑：`develop` 合入 `master`，推送到 `me` 远端（本地与远端一致）
  - 完成：`master` 与 `develop` 同指 `chore(gates)` 提交，`me/develop`、`me/master` 已推送
- [ ] 里程碑：`test:snapshot` 与 `test:web` 复核
  - [x] `test:snapshot` 回放/刷新两轮：语料策略、孤儿场景与 v4 词表修完，剩 7 个场景
  - [ ] 阻塞：7 个快照场景需带 `DEEPSEEK_API_KEY` 的重录（压缩摘要回退多发一次模型调用、MCP scope 失败文案）；本机无密钥，无法录制
  - [ ] 阻塞：`pnpm run test:web` 本机 40 分钟超时未跑完；本机 `DSH_HOME` 落在工作区内时 `arena` 报 `worktreeRoot must live outside workspaceRoot`，属本机前置；合并已修掉 `mcp-client/pool` 子路径导出缺失
- [x] 里程碑：本轮新增 `tmp/` 条目清理完毕