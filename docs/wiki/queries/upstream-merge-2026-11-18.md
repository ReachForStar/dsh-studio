---
title: 合并上游 upstream/master（2026-11-18，0.2.3-alpha.2 同步）
type: query
tags: [upstream-merge, 0.2.3-alpha.2, sqlite-persistence, mcp-oauth, settings-section, 会话格式]
created: 2026-11-18
updated: 2026-11-18
sources: []
status: active
---

# 合并上游 upstream/master（2026-11-18，0.2.3-alpha.2 同步）

## 一句话状态

上游 `dsh-v0.2.3-alpha.2` 线已合入（1753 个提交、5436 个改动文件、630 个冲突文件），`typecheck`、`build:artifacts`、`build:check`、`test:docs`、全量单测（64276 项）全绿；`test:snapshot` 仍有 7 个场景需要带密钥的重录，`test:web` 本机未跑完，均已在下文登记。

## 起点与终点

- 起点：`develop` 尖端为上一轮 pi 能力落地提交，merge-base 为上游 `0.2.2-rc.3` 发布合并。
- 上游目标：`upstream/master` 的 `0.2.3-alpha.2` 发布合并。
- 规模：1753 个上游提交、5436 个上游改动文件、1011 个与 fork 重叠文件、630 个冲突（其中 389 个是 `package.json`，371 个仅版本号）。
- 提交：`feat(merge)` 合并提交（双亲：fork 尖端 + `upstream/master`）与 `test(snapshot)` 夹具刷新提交。

## 冲突处理口径（沿用既有策略）

1. **生成物取上游后重生成**：`docs/{config,event-producer-consumer,module-graph,persistence,tool}-catalog.*`、`slot-catalog.ts`、`api-catalog.ts`、`pnpm-lock.yaml` 一律取上游侧后跑 `gen-*` 与 `pnpm install`。
2. **CI 工作流保留 fork 的删除**：上游 12 个工作流（含 `ci.yml`、`e2e.yml`、`release*.yml`）与 4 个断言型 spec 保持删除；指向它们的 Markdown 链接改写为 `.github/workflows/` 目录链接（归档笔记不改）。
3. **上游能力整体采纳**：`personalized-recommendations` 包退役、stale-PR 工作流新增、`account/` 与 `connector/` 包组重组、客户端域拆分。
4. **fork 自研能力全部保留**：pi 后端、SSH/SFTP、ui-polish 与画布、MCP 连接池与资源等待、会话 v5 写作与永久删除、工具检索、codemode、Git 检查点、input-handled、stats-float、论文阅读器、星域。

## 本轮新增的判定与修法

1. **上游客户端设置页重构后，fork 自研设置页改登记为独立分区**。上游删掉 `ui-settings-plugins`、`ui-settings-plugin-inventory`，把设置拆成 `settings.section` + 会话面板。fork 的 MCP 设置（`client/ui-settings-mcp`）原先注册到 `settings.plugins.tab`，改为 `settings.section`（独立「MCP」分区），组件 props 从 `PropsRuntime<'settings.plugins.tab'>` 换成 `'settings.section'`。
2. **上游把 MCP 换成 OAuth + 账号 + Host 架构时，fork 的连接池与资源等待要移植到新监管器**。做法：`mcp-client/src` 全部取上游，再重接 fork 的 `pool.ts`（租约 + 通知扇出）、`resource-watch.ts`（按代订阅、通知路由）、`connection.ts` 的 `joinShared`/`openPrivate`、`generation.ts` 的 `adopt(lease)`，并把 `resourceWatchTimeoutMs`、`maxResourceWatchTimeoutMs` 加回配置 schema。授权/令牌链路统一走上游 `McpOAuthCredentials`，fork 的 `oauth.ts` 删除，`pool-key` 改用 `config.oauth.credentialKey`。
3. **上游重新引入 SQLite 持久化（v4 血统），fork 的 v5 格式必须移植**。改动四处：`SQLITE_SESSION_FORMAT_VERSION` 4→5、头部 schema 增加 `backend`、行准入换 `assertV5RowAdmission`/`restoreReleasedV5Artifact`、实现 `delete`（先删 Trace 行再按「仅本 Trace 独占的 Segment」清理，事务内临时移除两条只可追加触发器）。`delete` 还需对未落盘的创建拒绝（`ownsWrite` → `SessionAlreadyOwnedError`）。
4. **v4 冻结词表要接纳上游同一代际内的改名**。上游把 `working-directory/change` 改名 `workspace-root/change`、新增 `action-cards/decision`，都留在 v4 里；fork 的 `RELEASED_V4_EVENT_TYPES` 补齐这两个名字，否则上游录制的 v4 会话在 v5 读取时报「unknown event type」。
5. **`SystemPrompt` 依赖 `ctx.sessionProjections` 后，测试夹具要跟着挂注册表**。fork 的会话分段准入特性让 `SystemPrompt` 注入 `sessionProjections`；上游大量测试只挂 `SystemPrompt` + `ToolRuntime`，插件串行激活失败导致 `ctx.tools` 未定义。批量补齐时注意：同一文件里 `SessionProjections`（复数，缓存包）已提供服务时不能再挂 `SessionProjectionRegistry`，否则报「service has been registered」。
6. **上游门禁把「实验包不得进入默认产品」收紧到可选 bundle 的组态**。fork 的 `dsh-browser-use` / `dsh-computer-use` 可选 bundle 直接挂实验后端；登记 `DEFAULT_PRODUCT_EXPERIMENTAL_PACKAGES` 并让「过期登记」只在包存在于当前根时判定，spec 的夹具补齐这几条预设行。
7. **`ctx.mcpPool` 不进入能力接缝表**：生成器要求接缝服务可渲染，包内服务改用 `SERVICE_WALK_EXEMPTIONS` 登记并指明文档归属；`SERVICE_ROLES` 里对应条目删除。

## 遗留与阻塞

- `pnpm run test:snapshot` 剩 7 个场景：`acp/image-compaction`、`sdk/ptc-cancel`、`session/{compaction-output-reserve, compaction-summary-headroom, model-switch-compaction, mcp-oauth-error, persistent-pwsh-padded-completion}`。前三类表现为「脚本用尽：请求第 4 次模型调用但脚本只有 3 次」——fork 的压缩摘要回退会多发一次路由模型调用，需要带 `DEEPSEEK_API_KEY` 重录；`mcp-oauth-error` 的差异是错误文案（上游把 scope 失败交给 SDK 的 `InsufficientScopeError` 文本），待重录时一并确认。
- `pnpm run test:web` 本机未跑完（40 分钟超时）；本机 `DSH_HOME` 落在工作区内时 `arena` 报 `worktreeRoot must live outside workspaceRoot`，与合并无关，属本机前置。
- `pnpm run lint` 仍有既有红项（`fork-gate-debt` 已登记），本次改动文件未新增。

## 复发预防

- **上游重构客户端域后，先查 fork 自研客户端包登记的槽位名**。`settings.plugins.tab` 一类槽位随页面重构消失，编译期能报出来，但要在同批改动里把测试与 README 一起更新。
- **上游重写「有 fork 插件」的包时，把 fork 的文件按「取上游 + 重接 fork 文件」处理**：`pool.ts`、`resource-watch.ts`、`client.ts`、`pool-key.ts` 这类上游没有的文件要保留并适配新签名（`McpGeneration.connect(config, timeoutMs, fetch?, authProvider?)`、`adopt(lease)`）。
- **测试夹具补依赖前先看同文件是否已挂等价的提供方**：`SessionProjections`（复数）与 `SessionProjectionRegistry` 注册同一个服务名，重复挂载直接抛错。
- **格式化夹具删除要成对进行**：只剩 `session.v5.jsonl`、没有 `snapshot.yml` 的场景目录是死目录，语料门禁会以「缺少 snapshot.yml」失败；Python PTC 场景随上游删除一并 `git rm -r`。
- **合并提交不要在中途 `git reset`**：`git reset` 会丢掉 `MERGE_HEAD`，之后 `git commit` 产出单亲提交，上游历史不再与 fork 相连；需要重排提交时用 `git commit-tree` + `git update-ref` 保留双亲。

## 关联页面

- [合并上游策略（2026-09）](../decisions/2026-09-upstream-sync.md)
- [上一轮合并（2026-11-15）](upstream-merge-2026-11-15.md)
- [MCP 连接池与 OAuth 交接](mcp-pool-oauth-handoff.md)
- [SSH/SFTP 能力接缝](../concepts/ssh-sftp-seam.md)