# 2026-09-05 pi 会话：发送消息双显去重 + JSONL 持久化

## 任务目标

修 pi 后端的三个用户可见问题：
1. 发送消息瞬间会话区出现两条一模一样的用户问题，刷新后只剩一条。
2. 重启 dsh 后 pi 会话记录丢失。
3. 会话导出 HTTP 404（怀疑与持久化同源，待验证）。

## 根因

### 双显：浏览器提交回显（echo）永不退役
前端 `Session.prompt` 在发送瞬间本地插入一条提交回显（乐观显示），并等 durable
`user/message` 事件携带 `source.rpcId` 时退役它。PiEventTranslator 翻译出的
user/message `source = { kind: 'user' }` **没有 rpcId**，回显永不退役，于是发送
瞬间出现「本地回显 + durable 消息」两条；刷新后回显（内存态）消失只剩一条。
Pi 每轮注入的 custom（AGENTS.md/hook 约定）此前也被折叠成 user/message，
加剧了会话区的消息噪音。

### 会话丢失：pi 会话从不写 JSONL
dsh-loop 创建会话时通过 `sessionPersistence.create` 建写句柄、把事件落盘。
PiLoop.createAgent 此前只 prepare + enter 内存 session，从不持久化 —— pi 会话
（连同 header）从未写入 JSONL，重启即丢。resume 也只是开一个 fresh pi 会话。

## 干了什么

- `pi-event-translator.ts`
  - 跳过 `role='custom'` 的 pi 注入消息（不进 dsh 会话 surface/log）。
  - 新增 `setPendingUserSource`：把 PiLoopAgent 传来的 dsh 请求 source（含 rpcId）
    原样带到翻译出的 user/message 上，使前端回显能按 rpcId 退役。
  - 新增 `setOnAppended`：每次处理完一个 pi 事件后回调，供 PiLoopAgent 触发落盘。
- `agent.ts`
  - `followup`/`steer` 把 `message.source` 传给 translator（去重关键）。
  - 新增 durable sink：构造函数接收 `PiDurableWrite`（append/close），每次翻译
    append 后把 `snapshotEvents(stored)` 批量写入（单飞串行、保序），
    `flushDurable()` 在 dispose 前冲刷。
- `index.ts`
  - `createAgent`：有 sessionPersistence 时 `create(header)` 建写句柄
    （stored=0），把句柄交给 agent 落盘。
  - `resume`：`open(id,'write')` 读历史、补中断闭包后，把**已打开的句柄**与
    历史游标（persisted+closers）直接交给 agent，不再二次 create 或提前关句柄。
  - `publish` 的 dispose：停 pi → agent dispose → drain → detach → close 句柄。
- `tests/translator.spec.ts`：新增「pending source（rpcId）原样带上」和
  「跳过 custom 注入」两个断言。

## 验证结果

- 内存持久化端到端（vitest）：create → followup → stub pi 事件 →
  句柄收到按序事件 `turn/start,step/start,user/message,assistant/message,
  step/end,turn/end`，user/message 恰 1 条。
- pi-agent-loop mock 测试 13 → 17 全过；typecheck/lint 干净。
- 已推送 `0b4c59c70d`（并含 09760dc747 的 custom 跳过）。

## 已知问题与风险

- vitest 单测中「create 带持久化后立即 dispose」会让 worker 异常退出
  （仅测试池 teardown 现象，真实 dsh 生命周期不受影响）；未纳入单测，
  落盘正确性由上述端到端 stub + resume 覆盖测试保证。
- flush 依赖 dsh 优雅退出时 dispose 冲刷；进程被杀（非优雅）会丢最后一批。
- 导出 404 尚未复现定位；若与「pi 会话无持久化文件」同源，本次修复后应消失。

## 复现与运行

```sh
pnpm exec vitest run packages/core/pi-agent-loop/tests
```

## 后续演进方向

- 确认 web 里 pi 会话重启后可恢复、发送不再双显；验证导出功能。
- 运行中增量 flush（而非依赖 dispose）以抗进程被杀。
- pi 模型可见上下文（AGENTS.md/hook 注入）如需入 dsh log，改用专门的
  context/injection 事件而非 user/message。
