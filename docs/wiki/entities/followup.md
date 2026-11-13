---
title: followup 下一步建议
type: entity
tags: [建议, 快模型, 会话事件, 展示数据]
created: 2026-11-11
updated: 2026-11-11
sources: []
status: active
---

# followup（下一步建议包）

## 职责

轮次完成后为用户提出至多 `maxSuggestions` 条具体下一步动作：`turn/end` 时用辅助模型读取本轮请求与最近回复的摘录，解析纯文本行，写最新覆盖的 log-only `followup/suggestions` 事件；永不进入模型可见表面。

## 关键文件

- `packages/context/followup/src/index.ts`：事件与 source kind 声明、Config、`renderSuggestionInput`、`boundUtf8`、`parseSuggestions`、`accumulateTurn`、`requestSuggestions`、`apply`。
- 持久化记录：`docs/persistence-changes/2026-11-11-followup.md`。

## 设计决策

- **轮次归属靠 `turn/start`**：`user/message` 事件数据不含 turn，插件按收到的 `turn/start` 归属；助手回复自带 turn。
- **增量累积**：不读历史事件，`session/event` 投递中累积当前轮的请求与回复文本，`turn/end` 时消费并清理。
- **解析以行为单位**：去掉列表编号与项目符号，逐行接受，条数与单条字符双上限；空回复不写事件。
- **失败不打断**：辅助请求失败或超时只 `ctx.logger.warn`。
- **UTF-8 安全截断**：`boundUtf8` 按字节截断后去掉尾部的替换字符，避免截断多字节码点。

## 验证

20 个测试、src 逐文件 100%（语句 98/98、分支 52/52、函数、行）；`doc-sync` 43 项通过；持久化记录 `ok: true`。

## 待确认

- Web 客户端卡片尚未消费该事件。
- 推测执行（同一 `fastModel` 配置驱动的第三件事）尚未实现：需要 fork 对话、写时复制 overlay 与审批模式门控。
