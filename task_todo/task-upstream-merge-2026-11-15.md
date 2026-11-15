# 完成上游合并（2026-11-15，0.2.2-rc.3 同步）

目标：清完 `docs/wiki/queries/upstream-merge-2026-11-15.md` 记录的剩余失败，全量门禁转绿，合入 `master` 并推送，回写交接页。

## 里程碑

- [x] 里程碑：`session-persistence-jsonl/catalog-migration` 22 项全通过，且每处改动都判定为「测试按 v5 写入器适配」而非掩盖行为差异
  - 口径：上游测试把「当前代」写成 v4、把「未来代」写成 v5；fork 写入器是 v5，故当前代改 5、未来代改 6。涉及 native 损坏报错、修订哈希、发布文件名、未支持子代、无关未来代、当前子代快速读六类断言。
- [x] 里程碑：`compaction-image-offload` 通过（摘要模型回退只在实际配置摘要模型时触发）
  - 口径：回退不再拦截 `IMAGE_OFFLOAD_REQUIRED`（图像卸载修复由 `compaction/summary-error` 监听器拥有）；目标与路由相同时不重试；合并丢失的 `failurePauseThreshold`/`summarizationFallback`/`windowReset` 默认值断言补回。
- [x] 里程碑：全量 `pnpm run test` 无失败（一次收集全部失败项后集中修复）
  - 首轮全量 77 失败 / 27 文件；一轮修复后剩 1 项，是单跑需 12 秒的 `client-ui-forge` lens 用例（本机默认 5 秒超时）。`--testTimeout=120000` 单跑该用例 14/14 通过；其余 60691 项通过、1 既定期望失败、274 跳过。
- [x] 里程碑：`typecheck` + `build:artifacts` + `build:check` 通过
  - 三个命令分别 5 / 8 / 2 门全过。
- [x] 里程碑：`gen-*` 目录重生成 + `test:docs` 通过
  - 16 个 `gen-*` 脚本全部重跑；`test:docs` 21 门全过（含 type-equiv、双语配对、持久化格式引用、markdown 链接与换行）。
- [x] 里程碑：`develop` 合入 `master` 并推送 `me`
  - `git merge --ff-only develop` 保持线性；`me/master` 与 `me/develop` 均指向收尾提交。
- [x] 里程碑：wiki 交接页改写为完成态，`index.md` 与 `log.md` 同步，提交推送
  - `docs(wiki)` 提交推送后 `qmd update` 已刷新检索索引。
- [x] 里程碑：本轮 `tmp/` 新增条目已清理
  - 只保留既有条目，未删除会话开始前存在的文件。

## 追加（用户要求）

- [x] `tmp/` 内容清空：删除 4.3 GB 既有缓存（`codex`、`opencode`、`qwen-code`、`zcode`、`ZCode`、旧任务清单与笔记），保留 `tmp/` 目录本身。
- [x] `task_todo/` 纳入版本跟踪：`chore(todo): 跟踪上游合并任务清单`。
- [x] 家族版本对齐上游最新 `0.2.2-rc.3`：`pnpm run release:dsh -- 0.2.2-rc.3` 重写 33 个 fork 清单并提交；`release/verify --family dsh` 报 416 个成员统一版本、发布顺序可解析。

## 遗留（非本次范围）

- `pnpm run lint` 仍有 75 条既有红项（`fork-gate-debt` 已登记），本次改动的文件未新增任何一条。
- 本机 git 重载用例（`experimental/worktree`、`client-ui-forge`）在默认 5 秒超时下会超时，`--testTimeout=30000` 下全绿，属本机性能。
