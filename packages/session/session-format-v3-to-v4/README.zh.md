---
description: "相邻的 V3 到 V4 会话转换：新增一个被准入的 surface 事件——免轮次的对等端助手消息——以及各代各自持有的词汇校验。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v3-to-v4

[English](README.md) | 中文

## 概述

将受支持的已发布 V3 会话恢复为 V4。这条边对事件体是恒等转换：只多准入一个 surface 事件 `assistant/peer-message`，它承载另一个智能体在本会话循环之外为本会话产生的助手消息。持久化通过静态目录使用本边；本库不读取或发布文件。

## 目录

- [使用本包](#use-this-package)
- [V3 到 V4 规范](#v3-to-v4-specification)
  - [头部](#header)
  - [事件体](#event-bodies)
  - [对等端助手消息](#peer-assistant-message)
  - [拒绝](#refusal)
- [原生 V4 准入](#native-v4-admission)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

恢复会话请使用[目录](../session-format-catalog/README.zh.md)。直接导入服务于目录装配与测试；本库没有 Cordis 挂载配置。[公开导出](src/index.ts)提供迁移声明、冻结的 V3 源编解码器、V4 目标编解码器、目标头校验器与目标恢复器。

### 入口

仅改头部的操作只重写版本字段：

```text
const targetHeader = sessionFormatV3ToV4.migrateHeader(sourceHeader)
```

完整恢复把解码事件喂进新的阶段。调用方不得把阶段的部分产出当作恢复成功：错误可能出现在更后面的事件或 `finish()`。[格式协议](../session-format/README.zh.md)负责阶段调度与目录错误处理；[JSONL 持久化](../session-persistence-jsonl/README.zh.md)负责读取准备与不可变后继发布。

-----

<a id="v3-to-v4-specification"></a>
## V3 到 V4 规范

<a id="header"></a>
### 头部

逻辑头部把 `version: 3` 改为 `version: 4`。其余字段（含 `backend`、`agentPreset`、`cwd`、`parentSession`、`origin`）原样保留。物理头行不新增字段，因此 V4 编解码器在重写版本号之后把分帧交给冻结的 V3 编解码器。

<a id="event-bodies"></a>
### 事件体

每个已发布 V3 事件都是合法的 V4 输入，并原样下发：序列位置、时间戳、消息身份、载荷、内嵌助手流与已审计引用都保持原值。本边不插入事件，因此没有本地引用或继承切口需要重映射。已播种会话的带标记继承切口映射到相同目标位置；外部传入的 `sourceInheritedEventCount` 必须与之一致，已播种日志缺少标记、或未播种日志带有标记，都按前序各代的规则拒绝。

<a id="peer-assistant-message"></a>
### 对等端助手消息

`assistant/peer-message` 承载 `data.message`：一条带 `id`、`role: 'assistant'`、`content` 与指明生产者的 `source` 的助手消息。它没有 turn、step 或提供方流，因为生产者在本会话循环之外运行；它和其余 surface 事件一样要求 `surfaceOp` 标记。它自带消息体，因此禁止 `sourceEventSeqs`。

它的 `source` 不得是 model 来源。model 来源会把另一个智能体的答复记成走本会话的模型路由，从而错标生产者，并错标以此为准的用量计账；持久化读取路径与本校验器都拒绝这类来源。已安装的来源指明对等端及其运行的技能。

<a id="refusal"></a>
### 拒绝

已安装词汇之外的必需事件类型会拒绝整份产物，并指明类型与序列。surface 替换仍不得遮蔽受保护的系统头，系统消息必须匹配打开的步骤，压缩不得遮蔽受保护的头。事件必须从零开始稠密。本边不做修复、不做代际回退、不改写文件。

-----

<a id="native-v4-admission"></a>
## 原生 V4 准入

已标记为 V4 的输入不跑 V3 到 V4。原生目录读取在 `validation: 'transformed'` 下只做编解码器校验；完整关系校验需要 `restoreReleasedV4Artifact` 或目录的 `validation: 'current'`。V4 校验在放宽后的 surface 集合上复刻 V3 的关系规则。它不委托给冻结的 V3 恢复器：前代会把无法归类的类型当作不透明事件，这正是更新的 surface 类型所需要的；而冻结的 V3 规则会把 `assistant/peer-message` 读成「已知的非 surface 类型」，进而拒绝它的 `surfaceOp`。前序链条仍为 V3 及更早产物持有各自的规则，线上路径在本恢复器之后还会跑已安装的当代校验。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 —— 点击展开</summary>

[阶段](src/migration.ts)按源坐标下发每个被准入事件，只跟踪继承切口。[编解码器](src/codec.ts)包住冻结的 V3 编解码器：为冻结的解码器重写物理版本号，在恢复前校验本代的结构化行，并在冻结解码器展开存储态 `sourceEventSeqs` 范围之后校验解码后的事件。[恢复器](src/validation.ts)持有上述关系规则。[载荷校验器](src/payload.ts)持有放宽后的 surface 集合与对等端消息的载荷规则。本库不发布运行期不变式伴生包，因为它不持有可独立观测的注册或状态副本。

在产物校验时，本代的 surface 事件会从前序词汇中屏蔽掉：那套词汇早于该类型，会拒绝它的 `surfaceOp`。[目录](../session-format-catalog/README.zh.md)按[包清单](../../../docs/session-format-status.zh.md)装配完整的相邻链条。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [已发布的 V2 到 V3](../session-format-v2-to-v3/README.zh.md) —— 冻结的前序转换及其源编解码器。
- [会话格式发布状态](../../../docs/session-format-status.zh.md) —— 写入器版本与已发布版本记录。
- [已发布格式策略](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md) —— 祖先保持冻结、后继新增的理由。

-----

<a id="model-experience"></a>
## 模型体验

### 对等端答复

#### 模型看到什么

对等端答复（`assistant/peer-message`）按日志顺序作为助手消息进入提供方转录，内容为记录值。本边本身不会给被转换的会话增加任何模型可见文本：未改动的 V3 日志产生的请求与转换前一致。

#### Token 影响

转换不增加 token。已记录的对等端答复在其内容被后续请求包含时按内容计费。

#### KV 缓存影响

本边保留历史请求含义；不保证提供方缓存命中，也不保证与原生 V4 记录逐字节一致。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **对等端答复没有轮次坐标** —— 生产者在本会话循环之外运行，因此对等端答复不带 turn 或 step，也不参与转录里的轮次分组。
- **不迁移文件与设置** —— 本包从不改动已提交的代际或 `settings.yaml`。发布最终后继由持久化负责；已存在的 V4 代不会重跑它的入边。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 —— 点击展开</summary>

无。

</details>
