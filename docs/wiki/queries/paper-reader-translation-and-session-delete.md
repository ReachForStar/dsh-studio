---
title: 论文阅读器翻译与会话永久删除
type: query
tags: [paper-reader, translation, session, delete, 已实现]
created: 2026-11-10
updated: 2026-11-10
sources: []
status: active
---

# 论文阅读器翻译与会话永久删除

## 问题

阅读器只有高亮、笔记与提问；用户无法在读过文字后直接得到译文。会话侧只有归档，日志永久留在磁盘上，手工删除又会留下 Workspace 记账、归档/置顶集合与客户端列表指向已不存在的 id。

## 根因

两处能力缺口，不是缺陷：阅读器没有宿主侧模型调用，会话持久化接缝也没有删除操作。两者都需要新能力并各自补齐引用清理。

## 解法

### 论文阅读器翻译

- 新增宿主路由 `/paper-reader/translate`（`src/translate-service.ts`、`src/route.ts`）：校验 `{ text, target }`，按 provider 顺序遍历 `llmRouteCandidates`，以 NDJSON 返回 `delta` 行、`finish` 行；首个片段之前的失败是 502 JSON，之后的失败是 `error` 行，客户端断开时中止模型调用。正文上限 20 万字符、请求体 512 KiB。
- LLM 路由与流式调用所需的消息构造由 `@deepseek-ai/dsh-llm/route`（`llmRouteCandidates`/`listLlmModels`/`llmRouteKey`）与 `createUserMessage` 提供。`llm-route.ts` 从 `ui-polish` 迁入 `dsh-llm`，两个宿主功能共用同一份候选路由；`tsconfig.base.json` 增加子路径映射，`safeHostDependencyExports` 登记 `dsh-llm` 与 `dsh-llm/route` 的运行时导出。
- 客户端：选区菜单新增「翻译」；工具条新增「翻译全文」，按页用 `extractPageText`（`src/client/pdf/extract.ts`）提取文字，跳过空页后逐页提交。结果进入 `TranslationCard`（可关闭、可复制、中/英切换）；卡片状态由 `PdfViewer` 持有，关闭即中止请求。
- 目标语言取自界面语言：`zh*` 为中文，其余为英文；`src/client/index.ts` 通过 inject `hooks: { language: ctx.locale }` 把它作为 `useLanguage` 传给页面。
- 文案补 8 种语言；`src/http.ts` 抽出两个路由共用的请求体读取与 JSON 应答。

### 会话永久删除

- `SessionPersistence.delete(id, options?)`：接缝唯一的破坏性操作。删除该会话的完整持久产物，未知 id 返回 `false`；写句柄持有时以 `SessionAlreadyOwnedError` 拒绝。JSONL 后端先取内核写锁再删除目录，并中止同一会话在途的历史迁移。
- `WorkspaceRegistry.deleteSession`：先拒绝本进程仍打开的会话（`WorkspaceLiveSessionError`）与提供方报告仍在运行的会话（`WorkspaceActiveSessionError`）；通过后删除日志、清除头部/路径缓存、从每个 Workspace 记录与归档/置顶集合中移除。未知 id 幂等返回 `false`。工作区文件与工作树绝不触碰。
- 宿主命令 `workspace/deleteSession` 返回 `{ deleted }`，把两种拒绝映射为 `workspace/session-open` 与 `workspace/session-active`；客户端 `WorkspaceDeleteSessionError` 携带 `rpcError`。
- 客户端：会话行「⋯」菜单新增「永久删除」（已归档行同样可用），`SessionDeleteConfirmDialog` 第一次点击进入待确认、第二次才执行，取消不写入；成功后 `sessions.refresh()` 刷新宿主权威列表。文案补 8 种语言。
- 升级指南 `docs/upgrade-guide/v0.2.2-rc.1/session-persistence-delete/` 记录抽象方法新增，仓库外后端需实现。

## 涉及模块

- `packages/client/ui-paper-reader`：`translate-service.ts`、`http.ts`、`route.ts`、`client/{PdfViewer,TranslationCard,paper-api,PaperReader,index}.tsx`。
- `packages/llm/llm`：`src/route.ts` 与 `./route` 导出；`packages/client/ui-polish` 改从新子路径导入。
- `packages/session/session-persistence`、`packages/session/session-persistence-jsonl`。
- `packages/workspace/workspace`、`packages/api/workspace-controller`、`packages/client/ui-workspace`。
- 门禁接线：`scripts/package-dependency-policy.ts`、`scripts/gen-cordis-catalog.ts`、`tsconfig.base.json`。

## 验证

- `ui-paper-reader`：14 个 spec、197 项测试，`src/**` 逐文件覆盖率 100%（语句/分支/函数/行）。
- `ui-workspace`：15 个 spec、526 项测试，覆盖率 100%；`workspace-controller`、`workspace`、`session-persistence-jsonl` 的删除用例与契约套件通过。
- `tsc` typecheck 五门通过；`oxlint` 相关目录无错误；`jscpd` 无新增克隆；`verify-client-ui-i18n`、`verify-locale-metadata`、`verify-translation-pairing`、`verify-md-*`、`verify-upgrade-guides`、`verify-agent-note-format` 通过。
- 已重建 `ui-paper-reader` 与 `ui-workspace` 的客户端产物。

## 复发预防

- 新的持久化层删除能力必须走 `SessionPersistence`，不要绕过接缝直接删目录；注册表与客户端列表的引用由 `WorkspaceRegistry.deleteSession` 统一清理。
- 跨包 LLM 路由不要再复制候选遍历；使用 `@deepseek-ai/dsh-llm/route`，新增运行时导出时同步 `safeHostDependencyExports`。
- 客户端删除类操作保持「待确认 + 二次点击」，并在成功后刷新宿主权威列表。
