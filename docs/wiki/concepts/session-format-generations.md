---
title: 会话格式代际（相邻迁移链）
type: concept
tags: [session-format, 迁移, 版本, surface, 发布]
created: 2026-09-24
updated: 2026-09-24
sources: []
status: active
---

# 会话格式代际（相邻迁移链）

## 定义

会话日志（JSONL）带一个单调递增的格式号 `SESSION_FORMAT_VERSION`。每个号是**一代**，代与代之间由**相邻迁移包**（`packages/session/session-format-vN-to-vN+1`）连接，`session-format-catalog` 把它们编译成一条完整、唯一的链条，持久化层按此读取历史日志并发布当前代。

## 要点

- **写入器决定是否 bump**：判据是「旧运行时能否在语义正确的前提下处理新日志」。笔记把**结构性改动**列为必须 bump：头部形状、事件信封、核心事件语义、**surface 机制（`SurfaceEventType` 集合、`SurfaceOp` 变体）**。
- **普通事件新增不 bump**：靠信封上的 `ignorable: true`。读取器遇到不认识的类型，默认**拒绝**（除非带该标记）——默认必读，忘记标记只会「多拒」，而默认可忽略会「静默重建出错」。
- **旧代冻结**：已发布的一代不得改动其规则；新增能力只能作为**新一代**（新包 + 新目标编解码器/校验器），历史代继续按原样运行。
- **一代包是套娃**：`releasedV4SessionFormatCodec` 包住 `releasedV3SessionFormatCodec`，把自己新增的物理字段在交接前剥掉、编码后回贴；`restoreReleasedV4Artifact` 承担本代的产物校验。
- **编辑链要成套**：`createSessionFormatChain` 校验相邻链唯一且完整，**缺一代直接抛错**；只要改了版本常量而迁移边没同时落地，会话持久化就拒绝初始化。

## 在本项目中的具体含义

当前写入器为 **v4**（`packages/core/session/src/types.ts`）。v3→v4 是**恒等转换**：只多准入一个 surface 事件 `assistant/peer-message`（另一个智能体在本会话循环之外产出的助手消息），事件体、坐标、身份、引用全部原样保留。

## 新增一代的落地顺序（不可调换）

1. **先归档当前代**：`pnpm run verify-persistence-formats --archive <当前版本>` —— 必须在 bump **之前**跑，否则工具会因「当前写入器已不是该版本」而拒绝；它产出的 `vN.schema.json` 是新历史参考的真源。
2. 建 `packages/session/session-format-vN-to-vN+1/`：`package.json`（含 `dsh.sessionFormatMigration` 代际清单块）、`tsconfig.json`、`tsdown.config.ts`、双语 README、`src/{index,codec,migration,payload,validation}.ts`、`tests/`。
3. 登记：`tsconfig.host.json` 引用、`session-format-catalog` 的依赖与 tsconfig 引用、`gen-tsconfig-paths`（否则解析会落到过期 `lib/`）。
4. 改 `SESSION_FORMAT_VERSION` 与当代类型；跑 `gen-session-format-catalog`、`gen-persistence-catalog`。
5. 写历史参考 `docs/persistence-changes/historical-formats/vN.md` + `.zh.md`（含 ```yaml persistence-format``` 机器记录块与 schema 区域标记），再 `pnpm run verify-persistence-formats --write` 填区域与索引。
6. 同步 `docs/subsystems/session.md` 的 type-equiv 区块（双语块必须字节一致），并 `verify-translation-pairing --write` 记录配对。

## 两个踩坑（2026-09 实测）

- **冻结的前代无法归类更晚出现的 surface 类型**：v3 的 `assertV3Event` 会把已安装词汇里的未知类型读成「已知的非 surface 类型」，进而拒绝它的 `surfaceOp`。因此 v4 的恢复器**不整份委托**给 v3，而是自己承担「未知事件拒绝 + 密度 + 受保护系统头」等关系校验；前序链条仍为更早产物持有自己的规则。
- **行级准入只做窄检查**：编解码器对**原始行**只做结构化准入，完整事件校验必须在**解码后**跑——存储态的 `sourceEventSeqs` 在解码器展开成序号之前是 `[[start, end]]` 范围形式，在行级做完整校验会把它判死。

## 关联页面

- [落到 v4 的交接：席位答复以 assistant 角色进模型可见内容](../queries/session-format-v4-landing.md) —— 本次换代的需求、证据与实施结果。
- [会话重载校验报错：assistant/message 空 model 来源](../queries/session-reload-model-source.md) —— 同一批会话格式工作的另一处修复。
