---
title: 会话内容宽度轴（--dsh-chat-content-width）
type: concept
tags: [web, ui, conversation, layout, css-variable, slider]
created: 2026-09-17
updated: 2026-09-19
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

- `--dsh-conversation-column-width`：由宽度控件发布（自适应项按列宽而非视口，因为折叠侧栏会改变列宽而不改窗口）。
- `--dsh-chat-user-width`：用户选定值（localStorage 键 `dsh.conversation.contentWidth`，px）。存在时整体替换自适应项；窗口收窄时只重钳制显示值、不改写存储值（与 AppFrame 侧栏拖拽规则一致）。
- 钳制范围：`[640, 列宽 - 176]`（176 = 每侧 88px 边距预算，沿用既有数值，使已存储宽度保持原尺寸）。

## 控件（2026-09-17 起，2026-09-19 恢复）

宽度由 `ui-primitives` 的 `Slider` 选择，渲染为**滚动区上方**的一条长条（长度即内容宽度），带 `data-conversation-width-slider` 标记，仅在有记录时（active 阶段）出现；列出 overlay 视图（trajectory 等）仍隐藏该长条。控件自身在会话 `.body` 内、`[data-conversation-scroll]` 之前，处于文档流中，因此不会盖住它所测量的记录区。

工厂本地组件（`conversation.content` 的 `widthControls` 槽）**拿不到 locale 注入**：`ConversationWidthControlsInputProps` 只声明 `container` 与 `phase`，而 `FactoryRegistrationPropsOf` 里的 `PropsLocale` 只是类型层面的组合。文案因此由 `ConversationContent`（工厂组件，`t` 可用）经 input props 注入：`widthLabel` 与 `widthValueText(width)`，locale 键仍是 `width.slider` / `width.sliderValue`。

矩形很窄时（列宽 ≤ 640 + 176）可调范围退化成一个点，控件此时**不渲染**——一个 min 等于 max 的滑块只能展示固定宽度。

## 作用域

宽度轴的两个变量都写在**会话面板自己的根元素**上（`ConversationWidthControls` 取 `container.parentElement`）：`--dsh-chat-user-width` 与 `--dsh-conversation-column-width`；面板卸载即随之失效。全仓读取 `--dsh-chat-content-width` / `--dsh-chat-user-width` 的只有 `ui-approval`、`ui-user-questions`、`ui-goal`、`ui-chat` 的 CSS，全部位于会话根子树内——**没有会话区之外的消费者，也没有第二处写入者**，因此改宽度不会外溢到其他页面。

偏好本身是**全局**的：单个 `localStorage` 键 `dsh.conversation.contentWidth`，所有会话共用（切会话沿用同一宽度）。若要改成按会话记录，需要把键改成含会话 id 的形式，并在读取时按会话回退到默认。

## 踩坑（2026-09-19）

第二轮上游合并（882 提交）把该控件覆盖回上游的**左右两条 40px 拖拽手柄**版本：`ConversationWidthControls.tsx` 整个文件取了上游侧，`Slider` 的实现只剩 `ui-primitives` 与 locale 键还在，Agent Note 记录的设计在代码里消失。恢复方式是按 Agent Note 重写该组件（Slider + 顶部条），删除 `.widthHandle` 系列的 CSS（命中条、辉光、`data-dragging`），并把 `tests/width-handle-styles.client.spec.ts` 换成 `tests/width-slider-styles.client.spec.ts`。

同批修掉的还有：`hero` 阶段与 `<640+176` 列宽不渲染控件、`skeleton.client.spec.tsx` 里手柄的指针/滚轮用例改为滑块的步进—持久化—重钳制往返。**判据**：宽度滑块的实现分布在 `ui-conversation/src/client/skeleton/ConversationWidthControls.tsx`、`ConversationRoot.module.css`（`.widthSlider`）、`ConversationContent.tsx`（渲染位置与文案注入）、`contract/slots.ts`（input props）五处，合并冲突时要一起看，只保文件不保语义会再次丢掉控件。

## 关联页面

- 长度决策与取舍见 Agent Note `.agents/notes/implemented/feature/2026-09-17-conversation-width-slider.md`。
- 会话统计与费用卡片见 [统计浮层（StatsFloat）](../entities/stats-float.md)。
