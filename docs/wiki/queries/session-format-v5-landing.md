---
title: 会话格式 v5 落地与 v4→v5 包的合并修复（2026-09-26）
type: query
tags: [session-format, merge, upstream, v4-to-v5, persistence-format]
created: 2026-09-26
updated: 2026-09-26
sources: []
status: active
---

# 会话格式 v5 落地与 v4→v5 包的合并修复（2026-09-26）

## 问题

合并上游后 `SESSION_FORMAT_VERSION` 由 fork 的 4 升为 5，新增包 `packages/session/session-format-v4-to-v5`。该包是「上游 v3→v4 边的逐字副本 + fork 方言补丁」，合并时 fork 补丁被上游副本整体覆盖，导致本包与依赖它的持久化/快照测试批量失败；文档门禁同时报该包缺登记与历史格式参考缺失。

## 根因与解法

| 失败 | 根因 | 解法 |
| --- | --- | --- |
| `SessionFormatUnsupportedMigrationError: deferLoading is defined only in V4` | 上游 v3→v4 边拒绝「源里带 `deferLoading`」，因为该字段只在它的目标代（上游 v4）定义；本包的目标是 v5，v4 与 v5 对该字段定义一致，源里带 `deferLoading: true` 是合法历史数据 | 删除迁移层的拒绝，改为原样通过；畸形值（`false`/`null`/字符串）交给原生接纳层：`releasedV5SessionFormatCodec.encodeEvent` 抛 `deferLoading must be true`。测试断言随之改为「迁移原样通过 + 编码层拒绝」，不在迁移层重复校验 |
| 未知内容标签位移测试失败 | 位移规则把未声明标签改写成 `plugin:<tag>`，而 `tool-addition`/`tool-removal` 在 v4 已声明、v5 的 `developer/message` 用 `headerSeq` 按原标签绑定它们；被加前缀后 v5 侧绑定失效 | 在 `src/content.ts` 的 `DECLARED_BLOCK_TYPES` 补上这两个标签（含 `tool-result`），`migrateBlock` 与 `migrateChunk` 共用该集合 |
| README 版本代际错乱 | 从上游复制的 `README.md`/`README.zh.md` 仍是「v3→v4」叙述，标题、锚点、表头、`version: 3 变为 4`、`RELEASED_V3_EVENT_TYPES` 等全部落后一代 | 用一次性脚本做整体 +1 位移（保护 `released V2 framing`/`released V2 codec` 这类真正的上界表述），再按 fork 实情回填：`RELEASED_V4_EVENT_TYPES` 额外接纳 `assistant/peer-message`、消息遍历表与退役标签表加入 peer 事件、表面事件计数由「五种」改「六种」 |
| `doc-standard` 报包未登记 | 新包既不是插件也不是可安装 bundle | 在 `scripts/doc-standard.spec.ts` 的 `PACKAGE_LIBRARIES` 增一行 `packages/session/session-format-v4-to-v5` 及归类理由 |
| `verify-persistence-formats` 报缺 `v4.md`/`v4.zh.md`/`v4.schema.json` | 换代必须先归档当代，历史参考需要双语正文加机器记录块 | ① 合并前的 fork 提交上打标签 `dsh-session-v4`，用该检出跑 `tsx scripts/persistence-formats.ts --archive 4 --root <dir>` 得到 `v4.schema.json`；② 生成 `v4.md`/`v4.zh.md`（含 `persistence-format` 机器声明块，`source` 只接受 `tag: dsh-session-v4` 这类匹配 `^dsh-[A-Za-z0-9][A-Za-z0-9._-]*$` 的标记）；③ `pnpm exec tsx scripts/persistence-formats.ts --write` 填生成区与格式索引 |
| `pnpm run verify-persistence-formats -- --write` 报 `Unexpected argument '--write'` | pnpm 把字面 `--` 作为位置参数传给脚本，`parseArgs` 不认 | 直接 `pnpm exec tsx scripts/persistence-formats.ts --write` |
| 快照基准 `writer.expected.jsonl` 里版本仍是 4 | 写入器换代，快照回放产物按当代写出 | 刷新道重写 8 个 `writer*.expected.jsonl`；其余 79 个快照产物差异回退，留待独立评审（见「遗留」） |
| `pnpm run test:snapshot:refresh` 报「不是内部或外部命令」 | Windows 下 pnpm 脚本命令由 cmd 执行，不识别 `DSH_SNAPSHOT=refresh` 前缀 | 在 Git Bash 里直接 `DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.snapshot.config.ts` |

## 判定依据：迁移层该不该校验某字段

同一条边界反复出现：**迁移层只负责「源代际的声明能否被目标代际无损表达」**，字段级畸形由编解码器/接纳层负责。`deferLoading` 的拒绝、`tool-addition` 的前缀化都是把接纳层职责前移到迁移层，结果把合法历史数据判死。修法是删迁移层的额外拒绝、让目标代际自己的准入说话，并把测试写成「迁移通过 + 编码/接纳拒绝」两段。

## 遗留（待决策，非本轮引入）

- **fork 自有 v4 会话文件读不出**：`releasedV4SessionFormatCodec`（来自上游 v3→v4）要求生产者拥有的消息源，fork v4 行使用 `{ kind: 'plugin', plugin }` 包装，因此本仓库合并前落盘的 v4 日志无法按 v4 恢复。已在 [docs/persistence-changes/historical-formats/v4.md](../../../docs/persistence-changes/historical-formats/v4.md) 的「Verification and limitations」写明。可选方向：为 fork v4 方言提供宽容的源行接纳，或提供一次性迁移命令把 fork v4 升到 v5。
- **快照道 47 个场景需按 v5 写入器全量刷新并评审**，不属于 `pnpm run test`；刷新道一次写出 87 个文件，其中只有 8 个 `writer*.expected.jsonl` 属本轮必然变化。
- `scripts/no-unknown-casts.baseline.json` 随合并整体来自上游，不含 fork 既有断言，代码定稿后需按当前树一次性重生成。

## 关联页面

- [会话格式代际（相邻迁移链）](../concepts/session-format-generations.md) —— 代际规则与同版本号双方言表。
- [落到 v4 的交接：席位答复以 assistant 角色进模型可见内容](session-format-v4-landing.md) —— `assistant/peer-message` 的来历。
- [本机（Windows）合并与门禁踩坑](windows-merge-gates.md) —— 环境类失败与判定方法。
