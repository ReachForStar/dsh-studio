---
title: 工具调度符号丢失导致任何工具调用崩溃（2026-09-24）
type: query
tags: [tools, agent-loop, tsx, symbol, module-duplication, a2a, xingchen]
created: 2026-09-24
updated: 2026-09-24
sources: []
status: active
---

# 工具调度符号丢失导致任何工具调用崩溃（2026-09-24）

> 现象：会话里发消息后本轮直接失败，报 `Cannot read properties of undefined (reading 'prepare')`；`/planning` 等 A2A 派发也随之不可用。表面像「某些工具坏了」，实际是**整个 dsh 工具调度路径崩**——只有 pi 后端自带的工具（如 `bash`）不受影响，所以容易被误判成"新建会话能跑"。

## 问题

用户在 Web 端发普通消息（如「帮我读一下项目」），模型调用 `glob` 后本轮立即失败：

```
tool/call  {"turn":2,"step":1,"callId":"…","name":"glob","arguments":"{\"pattern\":\"*\"}"}
turn/end   {"turn":2,"reason":{"kind":"error","error":{"message":"Cannot read properties of undefined (reading 'prepare')","code":"UNKNOWN"}}}
```

同一进程里另一次 `bash` 调用成功，于是先前的判断误入「是不是某个工具的问题」。

## 根因

崩点在 `packages/core/agent-loop/src/tool-calls.ts:170`：

```ts
const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
```

`TOOL_RUNTIME_SCHEDULER` 是 `dsh-tools` 用 `Symbol()` 造出的 `unique symbol`，作为服务的内部入口挂在 `ToolRuntime` 实例上。运行期诊断（临时注入构建产物，事后已移除）给出决定性证据：

```
agent-loop 文件:  file:///D:/deepseek-harness/packages/core/agent-loop/lib/index.js
ctx.tools:        lib 那份（isLibTools: true，libSymOnTools: true）
sameIdentity:     false      ← agent-loop 手里的符号不是它
```

即**同一进程里存在两份 `@deepseek-ai/dsh-tools`**：

1. 插件加载器按包名解析（走 `package.json` 的 `exports`）→ 命中构建产物 `lib/`；
2. 而 `lib/` 文件内部的裸导入 `@deepseek-ai/dsh-tools` 又被 **tsx 的 tsconfig paths 改写到 `src/`**。

两份模块各自执行一次 `Symbol('@deepseek-ai/dsh-tools.scheduler')`，得到两个「描述相同但身份不同」的符号；服务实例由 lib 那份安装，调用方（agent-loop）拿着 src 那份去取 → `undefined.prepare` 抛错。这属于仓库明令禁止的**源码面与产物面混用**：`lib/` 与 `src/` 同时在场时，任何跨包的 `unique symbol` 契约都会失效。

## 解法

把该符号改为**全局注册符号**，让重复副本也取到同一个身份：

```ts
export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol.for('@deepseek-ai/dsh-tools.scheduler')
```

`Symbol.for` 走全局符号注册表，同 realm 内无论模块被求值几次都返回同一个符号；`unique symbol` 的类型语义不变（TS 允许 `Symbol.for()` 作为其初始化器），调用方的类型完全不动。改完必须**重建 `lib/`**，否则旧产物那份仍是 `Symbol()`，两份依旧不相等。

## 验证

- 类型检查两面通过；`packages/core/tools` + `packages/core/agent-loop` + 三个客户端包共 93 个测试文件 / 1584 项全绿。
- 真实复现路径（`agent-browser` 驱动 Web 端，与用户同一会话 `session-fb3d4699`）：
  - 修复前：`CALL pwsh` → `TURN/END error: Cannot read properties of undefined (reading 'prepare')`（连续三次必崩）。
  - 修复后：`17:09:29 CALL pwsh → RESULT ok → TURN/END completed`。
- A2A 在对话内实测通过：`/planning 只回复四个字：修好了` → `command/run` → 若干 `xingchen/dispatch-progress`（working→completed，天梁/opencode/analysis）→ `assistant/peer-message`（role assistant，source a2a-seat）→ `command/done success`。

## 涉及模块

- `packages/core/tools/src/index.ts`（符号定义与 `ToolRuntime` 实例字段）
- `packages/core/agent-loop/src/tool-calls.ts`（调度入口，崩点）
- `packages/boot/app-boot/src/profile.ts`（按包名解析插件到 `lib/`）、tsconfig paths（把 `lib/` 内裸导入改写到 `src/`）
- pi 后端自带工具（`bash` 等）不经该调度，故表现为"部分工具能用"

## 复发预防

- 新增任何**跨包 `unique symbol`** 契约时改用 `Symbol.for('<package>.<name>')`；当前仓库此类导出只有这一处（已全量核对）。
- 该现象在诊断上有个易认特征：报错是 `reading '<method>'` 而非 `reading 'Symbol(...)'`，说明取到的对象存在、只是符号键落在另一份副本上。
- 运行期判定「是不是源码面/产物面混用」的最快手段：在可疑处打印 `Object.getOwnPropertySymbols(receiver)` 与目标符号的身份比较，再打印本模块的 `import.meta.url`。
