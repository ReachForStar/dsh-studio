---
title: 合并上游 upstream/master（2026-11-15，0.2.2-rc.3 同步）
type: query
tags: [upstream-merge, 交接, v5, 目录迁移, 客户端清单]
created: 2026-11-15
updated: 2026-11-15
sources: []
status: draft
---

# 合并上游 upstream/master（2026-11-15，0.2.2-rc.3 同步）

## 一句话状态

冲突已全部解决，`typecheck`、`build:artifacts`、目录生成与大部分测试集群已绿；仍有会话目录迁移与少量零散测试失败，因此 `develop` 只做了本地提交，**未推送、未合入 `master`**。

## 分支与提交

- 远端基线：`me/develop` = `me/master` = `97a17a5023`（本轮开始前）。
- 上游目标：`upstream/master` = `39163dd30f`（`dsh-v0.2.2-rc.3` 线）。
- 当前 `develop` 本地领先 8 个功能/修复提交（另有本交接页提交），未推送：
  - `33e45da088 chore(merge): 合并上游 upstream/master`（94 个冲突文件）
  - `657e329bb8 fix(merge): 恢复删除、二进制写入与镜像回退`
  - `6eb10b966a test(session-format): 适配 v5 写者`
  - `cb3a1d48e3 fix(desktop): flock 探测只要求宿主 addon`
  - `37f6bcd84a test(permission-presets): 补齐完全访问桩`
  - `dca45eab24 test(tools): 按参数修复语义更新校验用例`
  - `bcedb22be9 fix(client): 恢复星域与 Pi 预设文案映射`
  - `472a9d509b chore(gen): 重新生成目录与客户端清单`

## 冲突处理口径（本轮沿用既有策略）

1. **生成物取上游后重生成**：`docs/config-catalog.*`、`event-producer-consumer.*`、`module-graph.*`、`persistence-catalog.*`、`tool-catalog.*`、`slot-catalog.ts`、`pnpm-lock.yaml` 不手工合并，取上游后跑 `gen-*` 与 `pnpm install`。
2. **CI 工作流保留 fork 的删除**：上游的 `ci.yml`、`ci-master.yml`、`e2e.yml`、`release-publish.yml` 与对应自托管 spec 保持删除。
3. **上游删除的能力整体采纳**：Python PTC（`py-types.ts`、`py-types.spec.ts`、`ptc-python-turn` 快照、`packages/experimental/ptc-runtime-python`）与 `ptc-runtime-python` 的导出及残留目录一并移除。
4. **包清单与路径表取并集**：`apps/cli`、`apps/desktop`、`hooks-claude-code`、`tsconfig.base.json` 保留 fork 依赖/别名（btw、http-cassette、react 回退、webhook 旧路径）并补上游新增项。
5. **源码按来源意图合并**：上游重构与 fork 功能同时保留（compaction 的 `answeredRoute` + 窗口重置/熔断/回退；fs-local 删除与 `writeBytes`；worktree 镜像；web-fetch 域名清单 + 传输失败分类；client 样式工厂 + fork 构建插件）。
6. **测试按 fork 语义适配**：上游测试假设写者版本 4，fork 写者为 5；参数修复会把数字/布尔字符串化；菜单与预设含 fork 项。

## 已转绿的集群

| 集群 | 结果 | 关键修法 |
| --- | --- | --- |
| `session-format-v3-to-v4` | 404 项通过 | 原生会话 `version: 5`；v4 编解码器接收投影后的 v4 头；中断重启按修复语义断言 |
| `fs-local` | 231 项通过 | 补齐 `remove` 与 `writeBytes`（原子字节写入）；恢复 `applyLiteralEdit` 的引号/行号/转义/trim/缩进/块锚点降级匹配 |
| `worktree` | 109 项通过 | 纯文本后端镜像回退 `writeText`，二进制仍走 `writeBytes` |
| 默认产品隔离 | 通过 | 移除三条过期 fork 例外（browser-use-playwright-mcp、browser-use-runtime、computer-use-cua-driver-mcp） |
| `macos-notarization-proxy` | 17 项通过 | flock 探测只要求宿主 libc 的 addon，不再要求 landlock 与另一 libc 的二进制 |
| `permission-presets` | 78 项通过 | 测试用的 `approval` 桩补 `registerFullAccess`/`requestFullAccess` |
| `tool-fs-search` / `tool-bash` | 320 项通过 | 按 `repairArgs` 语义移除会被字符串化的数字/布尔用例 |
| 客户端预设与菜单 | 275 项通过 | 预设显示表补回 `xingchen-qiming`/`pi`；会话菜单接受 fork 的永久删除项 |
| 目录生成 | 全部通过 | `config`、`event`、`module-graph`、`tool`、`client-slot`、`cordis-inspect`、`plugin-packages`、`third-party` 重生成 |

## 剩余失败与下一步

### 1. `session-persistence-jsonl` 目录迁移（约 28 项，最大集群）

- 现象：
  - `catalog-migration` 的“malformed native catalog data”期望 `SessionPersistenceCorruptionError`，实得 `SessionFormatUnsupportedError`。
  - “keeps current revisions independent of unrelated historical logs” 期望父会话修订不变，实得哈希变化。
  - “publishes the parent without invented … child discovery information”“omits an unsupported child generation”等目录完成语义不符。
- 归属：fork 的 v5 目录在 `packages/session/session-format-v4-to-v5/src/{migration,facts}.ts`、`session-format-catalog`、`session-persistence-jsonl/src/catalog-migration.ts`。
- 判定口径：上游测试代表期望语义；先确认是 fork 代码需要对齐（错误分类、修订哈希、子目录发现信息），还是测试需按 v5 语义调整。不要只改测试期望来掩盖行为差异。
- 建议入口：先跑
  `LC_ALL=C pnpm exec vitest run packages/session/session-persistence-jsonl/tests/catalog-migration.spec.ts`
  逐个用例读断言与实现路径。

### 2. `compaction-image-offload`（4 项）

- 现象：摘要调用序列多出一次空调用（`[[],[],[],['first','second']]` vs `[[],[],['first','second']]`）。
- 归属：fork 的 `summarizationFallback`（配置摘要模型失败后改用会话路由模型）会额外发起一次调用；测试按上游调用次数断言。
- 判定：确认测试是否需要接受回退调用，或让回退只在明确配置了摘要模型时生效。

### 3. 零散项

- `tool-web`、`goal`、`auto-review`、`tool-executor-ptc`、`workspace-files/write`、`harness-dev-context`、`liveshare`、`typert` 目录校验、部分生成物脚本。
- 建议先跑受影响的单包测试，再按“合并前 HEAD 工作树作基线”区分预存失败与合并引入。

## 验证命令（本机）

```bash
# 环境前置：英文 git 报错与足够堆内存
export LC_ALL=C
export NODE_OPTIONS=--max-old-space-size=8192

pnpm run typecheck
pnpm run build:artifacts
pnpm run test            # 全量；当前仍有上述剩余失败
pnpm run test:docs       # 文档门禁，修完生成物后跑
```

本机注意：
- `apps/desktop` 的 flock 探测依赖宿主 addon；`pnpm run build:native-system` 只产出宿主 libc 的 `flock`，landlock/musl 属完整打包构建。
- `client-ui-forge` 的三个 git 用例在默认 5 秒超时下偶发超时，`--testTimeout=30000` 下全绿，属本机性能。
- 全量测试约 6 分钟；单包测试优先。

## 收尾步骤

1. 修完剩余失败后，跑全量 `pnpm run test`、`pnpm run typecheck`、`pnpm run build:artifacts`。
2. 重生成所有 `gen-*` 目录并跑 `pnpm run test:docs`。
3. `git checkout master && git merge --ff-only develop`（保持线性），或先合 `develop` 再推。
4. 推送 `me`：`git push me develop:develop`、`git push me master:master`。
5. 补记本页进展与 `log.md`。

## 本轮踩坑与复用要点

- `git checkout --ours/--theirs` 只改工作树，冲突文件需 `git add` 后才不再显示 `UU`。
- 编辑后必须先跑受影响包测试，再跑全量；分簇修比全量反复跑快。
- 上游新增的全覆盖表/生成器会直接指出缺失项（槽位预算、tsconfig 别名、客户端清单），报错通常比测试更早定位。
- 合并冲突解决时不要把 fork 自研功能整体替换成上游版；也不要把上游删除的能力用 fork 旧文件强行保留。
- 生成物不要手写合并，统一重生成；文档双语配对在改完 README 后用 `verify-translation-pairing --write` 重记。
