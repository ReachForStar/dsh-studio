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

## 彻底消除：启动方式必须与插件树同面（2026-09-24 追加）

上面的 `Symbol.for` 只是让符号契约对副本混用免疫；混用本身仍然存在，属仓库明令禁止的「源码面与产物面混用」，仍有其他潜在危害（同名模块两份、各自的模块级状态与注册表、跨副本 `instanceof` 判定）。彻底消除需要先弄清加载器的解析规则，实测结论如下：

- **插件树天生是产物面**：配置里的插件行是裸包名，由加载器经安装锚点（仓库 `node_modules`）走 Node 解析，命中包 `exports` 的 `lib/`。实测：把某个包的 `lib/` 临时移走后启动，报 `agent-loop (required) Package: @deepseek-ai/dsh-agent-loop` 加载失败——**加载器没有回退到 `src/` 的机制**。
- **tsx 的 tsconfig paths 只作用于它拦截到的裸导入**：`pnpm dsh`（`node --import tsx/esm apps/cli/src/bin.ts`）下，CLI 自身与 `lib/` 文件内部的裸导入都被映射到 `src/`，而插件行的入口解析走 Node 内部加载器、不受映射影响 → 于是 `agent-loop` 来自 `lib/`、它导入的 `dsh-tools` 来自 `src/` → 两份并存。
- **单面实测**（`import.meta.resolve`）：
  - 带 tsx：`@deepseek-ai/dsh-tools` → `packages/core/tools/src/index.ts`（源码面单份）；
  - 不带 tsx（从 `agent-loop/lib` 内解析）：→ `packages/core/tools/lib/index.js`（产物面单份）。

因此彻底消除的做法是**用构建产物启动，不开 tsx**：

```bash
pnpm run build            # 改完代码必须先构建
pnpm run dsh:built web    # 等价于 pnpm dsh web，但只走产物面
```

产物启动下所有裸导入（含 `lib/` 内部的）都由 Node 解析到 `lib/`，全进程只有一份同名模块。代价是源码改动必须重建才生效——但这一点原本就成立：插件树一直来自 `lib/`，`pnpm dsh` 的「源码启动」只覆盖 `apps/cli` 自身，容易造成「改了源码就生效」的错觉。

`pnpm dsh`（tsx 源码启动）保留，用于只改 `apps/cli` 的场景；改任何插件包都必须 `dsh:built`（或先构建再用 `dsh`，但不推荐混用）。
