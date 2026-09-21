---
title: 启动器改用构建产物面（2026-09-24）
type: decision
tags: [启动器, 模块解析, 源码面, 产物面, 门禁, 上游分歧]
created: 2026-09-24
updated: 2026-09-24
sources: []
status: active
---

# 启动器改用构建产物面（2026-09-24）

## 背景（现状与约束）

上游把根脚本 `dsh` 定为**源码启动**：`node --import tsx/esm apps/cli/src/bin.ts`（`.agents/notes/implemented/architecture/2026-07-29-dsh-source-launch-tsx-esm.md`），其意图是「不构建也能跑」。但这个意图只对 `apps/cli` 自身成立：配置里的插件行是裸包名，由加载器经安装锚点（仓库 `node_modules`）走 Node 解析，命中包 `exports` 的 `lib/`，而 tsx 的 tsconfig paths 只改写它拦截到的裸导入——于是同一进程里出现两份同名包

实测证据（详见 [工具调度符号丢失排查](../queries/tool-scheduler-symbol-duplication.md)）：

- 移走某包 `lib/` 后启动：该插件直接加载失败，加载器**没有 `src/` 回退**。
- 带 tsx 解析：`@deepseek-ai/dsh-tools` → `packages/core/tools/src/index.ts`；不带 tsx：→ `packages/core/tools/lib/index.js`。
- 运行期诊断：`agent-loop` 来自 `lib/`，它导入的 `dsh-tools` 来自 `src/`，两处 `unique symbol` 身份不等 → 工具调度入口取到 undefined，任何走 dsh 调度的工具调用（含 A2A 派发）崩溃。

约束：`apps/cli/tests/source-launch.compat.spec.ts` 直接断言根脚本的值，并在 Node 兼容矩阵里以 tsx 向量做无密钥冒烟；`.agents/notes/` 下的既有决策记录属冻结或现行记录，不改写（本次分歧记在本页）。

## 备选方案（各方案优劣）

- **A. 让加载器在源码启动时把插件行解析到 `src/`**：需要改 boot 与 vendored loader 的解析路径（内部加载器不走用户层 hook），风险落在上游拥有的解析代码上，且要同时兼容「已安装 profile」的代理模块机制。
- **B. 只把跨包 `unique symbol` 改成全局符号**（`Symbol.for`）：改动极小，已实施并验证；但两份同名模块、两套模块级状态、跨副本 `instanceof` 判定等危害依旧存在，属治标。
- **C. 启动器默认走构建产物面**（`node apps/cli/lib/bin.js`），tsx 源码启动降为备用脚本：全进程所有裸导入都由 Node 解析到 `lib/`，单进程单份模块；代价是改代码必须先 `pnpm run build`，并且与上游「不构建也能跑」的意图分歧，触发根脚本断言的门禁需要一并更新。

## 决策（选定方案）

选 **C**，并保留 B 作为第二道防线。

- `package.json`：`dsh` → `node apps/cli/lib/bin.js`；新增 `dsh:source` → `node --import tsx/esm apps/cli/src/bin.ts`。
- `apps/cli/tests/source-launch.compat.spec.ts`：断言改为校验这两个脚本的值，仍以 tsx 向量启动 `apps/cli/src/bin.ts`，保住该门禁「Node 版本变化会打到源码向量」的原意。
- 文档同步：`AGENTS.md` 命令注释、`apps/cli/README.{md,zh.md}`、`apps/cli/reference/README.{md,zh.md}`（含重新录制 `README.i18n.yaml` 配对状态）。

## 理由（决策依据）

- 之所以能这么选：插件树**一直**来自 `lib/`（加载器无 src 回退已实测），源码启动的「不构建」承诺对插件包从来没有兑现，只对 `apps/cli` 成立；改成产物面并不新增构建负担，只是让事实与启动方式一致。仓库根 README 第 62–66 行本来写的就是「`pnpm run build` 后用 `pnpm dsh web`，脚本使用这些构建产物」，本次改动让该描述成立。
- 不选 A：要动上游与 vendored 的模块解析路径，收益仅是保住一个名不副实的默认值。
- 不选只做 B：混用会持续存在，同类故障只会换一个符号或 `instanceof` 再犯一次。

## 后果（影响与后续）

- 改任何插件包后必须 `pnpm run build` 再 `pnpm dsh`；只改 `apps/cli` 时才用 `dsh:source`。
- 新检出在 `pnpm run build` 之前 `pnpm dsh` 会因缺少宿主产物而启动失败——这与根 README 的「先构建」说明一致。
- 与上游分歧挂在本页；若上游将来为源码启动补上插件行的源码面解析，可回到方案 A 并撤销本次切换。
- `apps/cli/tests/source-launch.compat.spec.ts` 继续覆盖 tsx 向量；CI 的 Node 兼容矩阵语义不变。
