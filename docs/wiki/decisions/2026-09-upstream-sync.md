---
title: 合并上游 upstream/master（2026-09）
type: decision
tags: [upstream-sync, merge, cordis, ssh, session-format]
created: 2026-09-17
updated: 2026-09-17
sources: []
status: active
---

# 合并上游 upstream/master（2026-09）

## 背景（现状与约束）

fork（ReachForStar/dsh-studio）自 merge base `d347e70390` 起有 99 个自研提交（pi 后端、SSH/SFTP、ui-polish、excalidraw、AMAX 网关、精简 CI），上游同期推进 1967 个提交（新 agent API、会话 v3 格式、能力接缝文档体系、双语配对门禁）。两侧都改动了 `packages/core`、`packages/api`、`packages/session`、`.github`、`docs/`，冲突 80 个文件。

约束：
- fork 自研功能必须保留；
- 上游非 fork 作者的改动必须整体采纳；
- 一手仓库只有一个 Host/Client TypeScript 程序，两侧的 `Context` 增广不能重复。

## 备选方案

| 方案 | 说明 | 取舍 |
| --- | --- | --- |
| 放弃 fork 特性、完全跟随上游 | 冲突最少 | 丢失 pi 后端、SSH/SFTP、ui-polish 等全部产品面，不可接受 |
| 保留 fork 分支、仅挑拣上游提交 | 无冲突 | 3576 个文件量级挑拣不可维护，且会持续落后 |
| 全量合并 + 按来源逐文件取舍 | 冲突集中、一次收敛 | 需要人工判定 80 个冲突文件与跨包 API 适配（本决策） |

## 决策（选定方案）

全量合并，冲突按**来源**取舍：fork 自研内容保留 fork 侧；上游改动取上游侧；双方都改的按双方意图合并。跨包 API 变更以「上游 API 为准、fork 调用点适配」处理。

关键取舍：

1. **`ctx.ssh` 让位给上游**：上游新增了同名的 SSH 连接服务（`packages/ssh/*`），与 fork 的 SSH/SFTP 接缝在同一 `Context` 上键冲突。fork 服务键改名 `ctx.ssh` → `ctx.sshSftp`，settings 命名空间、`ssh/pty/*` 事件名、工具名、Remote 命名空间 `ssh` 全部不变。详见 [SSH/SFTP 接缝](../concepts/ssh-sftp-seam.md)。
2. **会话 v3 头承载 `backend`**：上游 `SessionHeader` 已有 `AgentBackend = 'dsh' | 'pi'`，但 v2 物理头的已发布键集是冻结的。`session-format-v2-to-v3` 在 v2 校验前剥离 `backend`、在 v3 行上重新附加，`assertReleasedV3Header` 只对 v3 校验其取值。
3. **CI 只保留 fork 工作流**：fork 已放弃云端 CI，保留 `build-preview-cloudflare`、`expected-filenames`、`issue-policy`，另加上游新增且自包含的 `node-addon-system`（替代 `landlock-run`）。仅以 fork 已删除工作流为被测对象的 4 个 `scripts/*spec.ts` 一并删除。
4. **生成物冲突后重生成**：`docs/`、`*.i18n.yaml` 配对记录、lockfile 不经手工合并，改由 `gen-*` 脚本与 `verify-translation-pairing --write` 重新产出。
5. **`docs/wiki/` 排除双语配对**：fork 知识库（本目录）以中文维护，无英文对侧；在 `scripts/translation-pairing.manifest.json` 中以目录项 `docs/wiki/` 排除。

## 理由（决策依据）

- 冲突的可判定性：文件级来源归属比语义级猜测可靠；只有 80 个冲突文件需要人判断，其余 3400+ 文件自动跟随。
- 键冲突只能一方让位：单一 Host 程序无法同时存在两个 `ctx.ssh`；上游的 `ssh` 已被 `fs-ssh`/`subprocess-ssh`/`sandbox-ssh` 三个消费者依赖，改动面大于 fork 侧的两个消费者（`tool-ssh`、`host-ssh-remotes`）。
- 已发布格式不可变：v2 头键集由 `assertReleasedV2Header` 冻结，fork 字段只能作为 v3 的物理头增量，不能回填 v2。

## 后果（影响与后续）

- fork 会话记录的 `backend` 字段落位在 v3 物理头；旧 v2 日志的 `backend` 语义（无字段 = `dsh`）保持不变。
- fork 侧代码必须跟随上游 API：pi 后端改用 `agents.enter/announce`、`AgentSetup(ctx, agent)`、`SubprocessHandle.waitForExit(signal)`，`Inbox` 变为只读接口（见 [pi 后端](../entities/pi-backend.md)）。
- 已删除工作流的引用改为目录链接；`doc/` 下 fork 历史报告去除了提交哈希引用（保留正文，后续可迁入 wiki）。
- 验证口径：`typecheck`、`build` 通过；`pnpm run test` 全量跑通到「仅剩本机环境抖动」；`pnpm run test:docs` 20 个文档门禁全绿。
