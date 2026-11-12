---
title: speculation 推测执行门控
type: entity
tags: [推测执行, 门控, overlay, 安全, 预测触发]
created: 2026-11-11
updated: 2026-11-12
sources: []
status: active
---

# speculation（推测执行门控）

## 职责

两层职责。门控决定推测运行（用户输入前预执行）中每个工具调用的处置：只读工具 `allow`；文件写入在策略允许时 `redirect` 到 overlay 路径；其余一律 `boundary` 停止推测。运行方（runner）负责产生预测：轮次结束后用一次辅助请求预测下一次用户请求与其预先需要的工具调用，门控后逐个执行，并在用户下一条消息到达时提交或丢弃。

## 关键文件

- `packages/experimental/speculation/src/index.ts`：`Config`（`workspaceRoot` / `overlayRoot` / `allowWrites` / 工具与路径键覆盖）、`gateToolCall`、`gatePlan`、`overlayPath`、`rewriteArguments`、`resolvePolicy`、`BOUNDARY_TOOLS`。`SpeculationDecision` 是可判别联合，`redirect` 变体自带 `redirectKey` 与 `redirectPath`，消费者无需再判空。
- `packages/experimental/speculation/src/overlay.ts`：`OverlayFileSystem`（`FileSystem` 代理）：读取先探测 `<overlayRoot>/<相对路径>`，所有变更落到 overlay，按产出的路径集合 `commit` / `discard`。提交、丢弃、预置副本三段按路径列表抽成 `commitOverlay` / `discardOverlay` / `seedOverlay`，供不改参数而改提供者的调用方复用。
- `packages/experimental/speculation/src/runner.ts`：Cordis 插件（`@deepseek-ai/dsh-speculation/runner`，`inject = ['llm', 'tools', 'fs']`）。`turn/end` 触发一次 `speculation` 目的的辅助请求 → `parsePlan` 校验预测 JSON → `executePlan` 门控并逐个派发 → 记录 `speculation/proposal`；下一条 `user/message` 归一化后与预测相同且 `allowWrites` 开启时 `commitOverlay`，否则 `discardOverlay`，并记录 `speculation/outcome`。

## 设计决策

- **写入门槛默认关闭**：`allowWrites` 默认 `false`，任何推测写入都不执行；dsh 没有 qwen 的 `auto-edit`/`yolo` 审批枚举，改由显式配置表达「用户已同意无人值守编辑」。
- **越界即 boundary**：`overlayPath` 只映射仍位于 `workspaceRoot` 内的路径，`..` 或绝对外部路径直接 boundary，不做部分包含的近似判断。
- **未知工具保守**：MCP 与自定义工具一律 boundary；外部网络工具在固定集合中，配置无法放开。
- **纯函数门控 + 独立代理**：门控不执行 I/O；overlay 代理自建独立 Cordis 上下文注册服务，避免与企业 `ctx.fs` 冲突，运行方按需把代理交给推测会话。
- **提交按产出清单**：代理记录自己写过的 overlay 路径，`commit` 只把这些文件读回并写入工作区对应路径，`discard` 只删除这些文件，不会牵动 overlay 中的其他内容。

## 运行方决策

- **写入走参数改写而非代理注入**：工具插件在加载期绑定自己的 `ctx.fs`，无法按调用替换提供者；因此运行方用门控给出的 `redirectPath` 改写参数，让真实工具把内容写进 overlay 目录。`OverlayFileSystem` 只服务于「需要代理读」的调用方，两者共用同一套提交/丢弃实现。
- **预置 overlay 副本**：`edit` 类工具要求目标已存在，运行方在重定向写入前把工作区原文复制到 overlay 副本，使编辑打开的内容与模型读过的一致。
- **无 Agent 派发**：预测调用以 `agent` 缺席的方式进入 `ctx.tools.execute`；需要审批的工具因此直接失败，不会在推测期弹审批。
- **预测命中才提交**：确认条件是归一化后完全相同的文本（大小写与空白折叠），不做模糊匹配；未命中即丢弃，预测产物不会静默进入工作区。
- **单轮单次运行**：同一轮次只发起一次预测（`predictedTurns` 去重），用户中途输入会中止在途运行并丢弃已产出的 overlay 副本。

## 与 qwen-code 的差异

qwen 的门控含 shell 命令 AST 安全分类与审批模式枚举；dsh 目前不做 shell 分类（一律 boundary），写入许可改为显式配置。overlay 代理已实现（读优先 overlay、`commit` 提交、`discard` 丢弃）；提交时不做版本冲突检测，也没有界面。

## 验证

55 个测试（门控纯逻辑 18 个 + overlay 代理 11 个，后者用真实临时目录与 `dsh-fs-local`；运行方 26 个，覆盖预测解析、计划执行、提交/丢弃、在途中止与失败告警），src 逐文件 100%（语句 264/264、分支 139/139、函数 58/58、行 226/226）；`pnpm run typecheck`、本包 lint、`jscpd` 0 克隆、`doc-sync` 43 项通过。新增 `speculation/proposal`、`speculation/outcome` 两个 log-only 事件与 `dsh-speculation` 来源种类，持久化记录为 `2026-11-12-speculation`（same-version）。

## 启用记录（2026-11-12）

出厂组合里该行默认 `disabled: true`（缺 `provider`/`model` 会加载期抛 `speculation: provider and model must be configured together`）。启用写在 `~/.dsh/profiles/web/cordis.patch.yml`（改写前已备份为同目录 `cordis.patch.yml.bak-*-speculation`）：

```yaml
- id: speculation
  name: '@deepseek-ai/dsh-speculation/runner'
  disabled: false
  config:
    workspaceRoot: /data/f/BDJ-Train
    overlayRoot: !!js dshHomePath('speculation')
    allowWrites: false
    provider: magpie
    model: officeace/deepseek-v4.1-flash
```

- `provider`/`model` 取 profile patch 里 `agent-default-model` 的同一组值（`magpie` + `officeace/deepseek-v4.1-flash`）。
- `workspaceRoot` 最初取 `process.cwd()`（启动目录），后来改为工作区绝对路径 `/data/f/BDJ-Train`：门控按这个根解析相对路径，落在根外的路径一律 boundary。一项只能对一个根，换工作区就要改这一项。
- `allowWrites` 保持 `false`：推测期不执行任何写入。

验证：插件清单里 `include:speculation` 为 `enabled: true` / `active`；Web 会话跑真实对话后，会话日志（`session.v5.jsonl.zstd`）出现 `speculation/proposal`。两次实测：工作区在根外时预测「读一下 …README.md 的完整内容」的 `read` 记为 `failed`（预测期不带 Agent 派发，需要审批或越界的调用直接失败）；把根改为 `/data/f/BDJ-Train` 后预测「列出当前工作区根目录下的文件」的 `bash` 记为 `boundary`（shell 一律不推测）。

## 待确认

- 提交缺少版本冲突检测：`commitOverlay` 直接覆盖工作区文件，不比较 overlay 副本起始版本。
- shell 只读分类是否需要移植（当前 shell 一律 boundary）。
- 预测期读取看到的是工作区现状，看不到同一计划先前步骤的 overlay 副本。
- `overlayRoot` 下的残留副本在插件卸载/运行中止时尽力删除，失败只告警。
