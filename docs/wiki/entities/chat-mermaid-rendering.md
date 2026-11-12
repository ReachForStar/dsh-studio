---
title: 聊天内 Mermaid 渲染（ui-markdown-mermaid）
type: entity
tags: [客户端插件, 聊天围栏, mermaid, 按需加载, 槽位]
created: 2026-11-12
updated: 2026-11-12
sources: []
status: active
---

# 聊天内 Mermaid 渲染（ui-markdown-mermaid）

## 职责

`@deepseek-ai/dsh-client-ui-markdown-mermaid` 占用聊天 Markdown 围栏槽位 `conversation.chat.markdown.fence` 的 `mermaid` 语言：回复落定后把围栏画成 SVG；围栏仍在流式输出、或 Mermaid 拒绝该正文时，保留 owner 提供的 `FenceCodeBlock`。其他语言完全不经过本包。

## 关键文件与接口

- `src/client/index.ts`：`apply` 注册 `mermaid` 字典，并 `ctx.slots.inject('conversation.chat.markdown.fence', …)` 注册 `key: 'mermaid'` 的 HOC 层；`inject`（槽位注入面）返回 `renderDiagram` 与 `nextDiagramId`，两者都由 `apply` 闭包创建，避免模块级单例。
- `src/client/mermaid.ts`：`createMermaidRenderer()` 首次调用时动态 `import('mermaid')` 并 `initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true })`，返回 `(id, code) => svg`。
- `src/client/MermaidFenceLayer.tsx`：`streaming` 为真直接返回 `children`（owner 的代码块）；否则渲染 `MermaidDiagram`，其状态带 `body` 标记，渲染阶段比较 `state.body !== code` 做派生状态重置，effect 清理置 `current = false` 丢弃过期结果；`labels` 由 `t` 在层内取两个键。
- `src/client/MermaidFenceLayer.module.css`：仅用 `--dsw-alias-label-tertiary` 等 CSS 变量，无字面色值。
- `src/client/locales.ts`：`mermaid` 命名空间字典（8 语言），键只有 `loading` / `failed`。

## 上下游依赖

- 上游：`ui-chat` 声明围栏槽位并以 `entryKey = fence.lang` 分发（`ChatView` 的 `renderCode`）；`ui-primitives` 提供 owner 侧的 `FenceCodeBlock`（本包不直接 import，只渲染 `children`）。
- 服务：`ctx.slots`（`ui-renderer`）、`ctx.locale`（`client/locale`）。`dsh.client.inject` 只作信息性声明。
- 接线：`packages/bundle/web-app/cordis.patch.yml` 一行（`id: ui-markdown-mermaid`）+ `packages/bundle/web-app/package.json` 依赖 + `tsconfig.client.json` references + `tsconfig.base.json` paths。
- 打包：`mermaid` 只以动态 `import()` 出现在浏览器半区，私有打包（不声明 `dsh.client.external`），因此不进入 `PLATFORM_MODULES` 共享表。

## 重要变更记录

- 2026-11-12 新建：8 项测试（4 个组件行为 + 4 个槽位集成），逐文件 100% 覆盖。
- 构建实测（本机，`pnpm --filter … bundle`）：入口 `lib/client.js` 4.8 kB，动态根 `lib/client.mermaid.core.js` 47 kB，`lib/client.mermaid-parser.core.js` 29 kB；`lib/client.*.js` 共 100 个分块、原始 5.1 MB、gzip 合计约 1.17 MB；含 map 与 src 的发布 tarball 3.4 MB。聊天启动只加载 4.8 kB 入口，Mermaid 在第一个落定围栏处按需拉取。
- 已知取舍：`suppressErrorRendering: true` 是失败回退的前提（默认会画 Mermaid 自己的错误图而不抛错）；图表配色沿用 Mermaid 默认主题，未接 `--dsw-*`。详见 [opencode v2.2.7 能力面与可融入清单](../queries/opencode-v2-capability-comparison.md) 第 10 项。
