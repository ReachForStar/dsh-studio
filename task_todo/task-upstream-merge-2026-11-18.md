# 合并上游 upstream/master（2026-11-18，0.2.3-alpha.2 同步）

起点：`develop` 尖端为上一轮 pi 能力落地提交，merge-base 为上游 0.2.2-rc.3 发布合并。
目标：`upstream/master` 尖端为 0.2.3-alpha.2 发布合并，1753 个上游提交、5436 个上游改动文件、1011 个与 fork 重叠文件。

口径沿用既有决策（[合并上游](../docs/wiki/decisions/2026-09-upstream-sync.md)）：全量合并、按来源逐文件取舍、生成物一律重生成、跨包 API 以上游为准。

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
- [ ] 里程碑：`pnpm run test` 全量运行，失败项一次收集后集中修复并复跑转绿（本机性能类除外且需单独证据）
- [x] 里程碑：`pnpm run test:docs` 全过（含双语配对、持久化格式引用、链接与换行门禁）
  - 完成：21 门全过
- [ ] 里程碑：wiki 沉淀完成（本轮合并 query 页 + 既有决策页续轮 + `index.md` + `log.md`），相对链接有效
- [ ] 里程碑：`develop` 合入 `master`，推送到 `me` 远端（本地与远端一致）
- [ ] 里程碑：本轮新增 `tmp/` 条目清理完毕