---
title: 会话内容宽度轴（--dsh-chat-content-width）
type: concept
tags: [web, ui, conversation, layout, css-variable]
created: 2026-09-17
updated: 2026-09-17
sources: []
status: active
---

# 会话内容宽度轴（--dsh-chat-content-width）

## 定义

`ui-conversation` 会话列的唯一宽度来源：一个 CSS 变量 `--dsh-chat-content-width`，由记录区、dock 卡片与业务接管卡共用，输入卡片为它加 32px（`--dsh-composer-card-max-width`）。

## 组成

```
--dsh-chat-content-width = var(--dsh-chat-user-width,
  clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * 0.64), 920px))
```

- `--dsh-conversation-column-width`：由 `ConversationMainPanel` 的 ResizeObserver 发布（自适应项按列宽而非视口，因为折叠侧栏会改变列宽而不改窗口）。
- `--dsh-chat-user-width`：用户选定值（localStorage 键 `dsh.conversation.contentWidth`，px）。存在时整体替换自适应项；窗口收窄时只重钳制显示值、不改写存储值（与 AppFrame 侧栏拖拽规则一致）。
- 钳制范围：`[640, 列宽 - 176]`（176 = 每侧 88px 边距预算，沿用既有数值，使已存储宽度保持原尺寸）。

## 控件（2026-09-17 起）

宽度由 `ui-primitives` 的 `Slider` 选择，渲染为滚动区上方的一条长条（长度即内容宽度），仅在有记录时（active 阶段）出现。此前的左右两条 40px 拖拽手柄与辉光已删除。列出 overlay 视图（trajectory 等）仍隐藏该长条。

## 关联页面

- 长度决策与取舍见 Agent Note `.agents/notes/implemented/feature/2026-09-17-conversation-width-slider.md`。
- 会话统计与费用卡片见 [统计浮层（StatsFloat）](../entities/stats-float.md)。

## 作用域（2026-09-17 核查）

宽度轴的两个变量都写在**会话面板自己的根元素**上（`ConversationMainPanel.tsx` 的 `rootEl`）：`publishWidths` 写 `--dsh-chat-user-width`，`publishColumnWidth` 写 `--dsh-conversation-column-width`；面板卸载即随之失效。全仓读取 `--dsh-chat-content-width` / `--dsh-chat-user-width` 的只有 `ui-approval`、`ui-user-questions`、`ui-goal`、`ui-chat` 的 CSS，全部位于会话根子树内——**没有会话区之外的消费者，也没有第二处写入者**，因此改宽度不会外溢到其他页面。

偏好本身是**全局**的：单个 `localStorage` 键 `dsh.conversation.contentWidth`，所有会话共用（切会话沿用同一宽度）。若要改成按会话记录，需要把键改成含会话 id 的形式，并在读取时按会话回退到默认。
