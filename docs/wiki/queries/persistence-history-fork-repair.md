---
title: 持久化历史分叉与来源种类补记（2026-10-27）
type: query
tags: [持久化, persistence, 门禁, 分叉, 上游合并, fork]
created: 2026-10-27
updated: 2026-10-27
sources: []
status: active
---

# 持久化历史分叉与来源种类补记（2026-10-27）

## 问题

`pnpm run verify-persistence-changes` 在本树预先失败，报 `schema inventory: missing field nodes`。修复该布局问题后暴露出两层更深的缺口：记录历史分叉，以及一处未确认的根转换。

## 根因与修法

### 一、v5 记录快照仍是旧布局

`docs/persistence-changes/2026-10-03-session-format-v5.schema.json` 用的是旧布局（根内嵌 `schema: { root, nodes }`，无顶层 `nodes` 表），而门禁在 v2 归一化版本下要求顶层 `nodes`。该文件由 fork 用旧布局生成，上游后来把持久化 schema 升级到 v2 布局（顶层 `nodes` + 摘要前缀键），历史归档重编码只覆盖了 `historical-formats/`，遗漏了这条 fork 记录。

修法：用 `encodePersistenceSnapshot` 重编码——逐根校验「内嵌 schema 摘要 == 根 digest」全部通过（digest 未变，只是布局重排与共享节点去重），文件从 15453 行降到 267 行。

### 二、记录历史分叉

分叉出现在 4 个共享根上：fork 的 `2026-10-03-session-format-v5` 与上游的 `2026-10-22-action-card-status` 都把 `event:agent/inbox/spliced`、`event:developer/message`、`event:session/title-llm-request`、`event:user/message` 的 `previous` 指向同一个 `2026-10-13-user-rpc-principal`。门禁要求每个 `(父记录, 根)` 只有一个子记录。

修法方向只有一个：**改上游 `action-card-status` 的这 4 个根**，让它们以 v5 为父，`after` 更新为当前源码 digest，快照重编码为 v2 布局。理由：

- 语义上 v5 状态不含 `action-cards` 来源种类，`action-card-status` 状态含它，所以顺序必须是 `…→ 10-13 → v5 → action-card-status`。
- 反向（让 v5 以 action-card-status 为父）不成立：v5 快照的 source 联合里没有 `action-cards`，与「v5 在 action-cards 之后」矛盾。
- 事实时间顺序一致：v5 名义日期 10-03，action-cards 10-22。

### 三、未确认的根转换

`event:assistant/peer-message` 的 `source` 属性承载的是**可合并扩展的消息来源联合**（整个 `MessageSourceMap`），不是 `user`/`developer` 消息的归属绑定，因此上游新增 `action-cards` 来源种类无法走 `attribution-only source kind added` 豁免，只能判 `union-variants-changed`（需兼容性审查）。

修法：新增记录 `docs/persistence-changes/2026-10-27-fork-peer-source-kind.md`（`same-version`，`previous: 2026-10-03-session-format-v5`）。兼容性依据：新增来源种类对读者是追加式——未挂载 `action-cards` 生产者的读者原样保留消息与 JSON 元数据、把通知文本当普通上下文派生，这是它对每个未生产来源种类的既有行为；既有记录不会携带该值，因此解读方式不变。

`event:subagent/catalog` 曾看似也需要记录（早先用 `unknown-child-catalog` 快照对比得 `payload-version-added`），实际其 tip 是 `2026-09-19-external-subagent-catalog`，digest 与当前源码相同，无需记录。**判定要看门禁口径的 history tips，不能自己按文件名字母序取「最后一条记录」。**

## 验证

```
pnpm run verify-persistence-changes   # 67 roots match 19 history records
pnpm run verify-persistence-catalog   # 生成物最新
pnpm run verify-persistence-formats   # v0 through v5 verified (6 complete references)
pnpm run verify-persistence-releases  # 26 records, 25 adjacent transitions verified
pnpm exec vitest run packages/experimental/action-cards/tests   # 4 files, 28 tests passed
pnpm run typecheck                    # 5 门全绿
```

`packages/subagent` 各套件在本树预先失败（167 项，在未修改检出上同样复现），因此本页不声称任何 subagent 结论。

## 涉及模块

- [持久化变更流程](../../../docs/cookbook/reviewing-persistence-type-changes.md)：记录生成、兼容性判断与验证步骤。
- [会话格式 v5 落地](session-format-v5-landing.md)：该批的 v5 记录与来源类型豁免。
- [fork 自研包的门禁红项清单](fork-gate-debt.md)：本项已从红转绿。

## 复发预防

- **v1 旧布局的历史快照要单独重编码**：上游把持久化 schema 升到 v2 布局时，`historical-formats/` 与 `persistence-changes/` 两处都要覆盖；fork 新增的记录若产生于升级之前，合并上游后需重编码。
- **合并上游后核对分叉**：fork 记录与上游记录若声明了同一个共享根，必然分叉；合并后要跑 `verify-persistence-changes`，按语义顺序改掉其中一条的 `previous`，不要靠删除记录绕过。
- **判断某根是否需补记录，读门禁的 history tips，不要自己遍历记录取「最后一条」**：记录文件名顺序不等于历史链顺序。