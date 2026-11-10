---
title: 论文阅读器翻译与会话永久删除（待实现）
type: query
tags: [paper-reader, translation, session, delete, 未实现]
created: 2026-11-10
updated: 2026-11-10
sources: []
status: draft
---

# 论文阅读器翻译与会话永久删除（待实现）

## 现状

阅读器已完成：右栏标签页、可滚动页面、笔记独立右栏（红边条目）、黄色高亮、带笔记用红色下划线、点击高亮删除、缩放 50%–300%（步进 25%）、指南入口第一位（order 5）、插件发现入口只保留在左侧栏「更多」。会话侧目前只有归档。

## 待做一：论文阅读器翻译

- 选中翻译：文字选区菜单新增「翻译」，结果进入右侧翻译卡片（可关闭、可复制）。
- 整篇翻译：阅读器工具条新增「翻译全文」按钮；按页用 pdfjs `getTextContent` 提取文字后提交。
- 目标语言默认跟随界面语言；结果卡片可切换中/英。
- 宿主新增 `/paper-reader/translate` 前缀路由：复用 `llm-route.ts` 的候选路由与流式输出（参考 `git-llm.ts` 与 LaTeX 写作的流式实现），逐段返回 NDJSON；不新增模型配置项。
- 文案：`locales.ts` 补 8 种语言（zh/en/ja/es/fr/de/ru/pt）。
- 验收：客户端组件与宿主路由测试；`ui-paper-reader/src/**` 逐文件覆盖 100%；`verify-client-ui-i18n`、`verify-locale-metadata` 通过。
- 涉及文件：`packages/client/ui-paper-reader/src/{index.ts,paper-service.ts,route.ts,client/{PdfViewer.tsx,PaperReader.tsx,locales.ts,paper-api.ts}}`。

## 待做二：会话永久删除

- 范围：只删除会话记录与消息日志 `~/.dsh/sessions/<id>/`；**不删除**工作区文件与工作树，不改工作区目录。
- 入口：会话行「⋯」菜单新增「永久删除」。
- 确认：二次确认（输入会话名或再次点击确认按钮）；取消不产生任何写入。
- 已归档会话同样可以从归档列表永久删除。
- 宿主：新增删除能力（磁盘目录 + 工作区注册表 + 会话列表投影同步），删除后该 id 不再出现在任何列表；针对不存在或已删除的 id 幂等。
- 文案：归档菜单所在包的 `locales.ts` 补 8 种语言。
- 验收：宿主路由/服务测试覆盖删除成功、不存在、已归档、删除中失败；客户端菜单与确认框测试；相关包逐文件覆盖 100%。
- 风险：不可恢复；实现时不得顺手删除工作区文件或工作树。

## 顺序与提交

1. 翻译：独立提交（feat）。
2. 永久删除：独立提交（feat），提交正文写明删除范围与不删工作区文件的约束。

两项目标语言与确认交互均按上文执行，不再变更。
