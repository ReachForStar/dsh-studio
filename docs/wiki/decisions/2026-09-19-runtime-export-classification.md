---
title: 跨包运行时导出的重复安装分类（2026-09-19）
type: decision
tags: [依赖策略, 门禁, 客户端包, 运行时身份, 发布布局]
created: 2026-09-19
updated: 2026-09-19
sources: []
status: active
---

# 跨包运行时导出的重复安装分类（2026-09-19）

## 背景（现状与约束）

`verify-package-dependencies` 要求：带 Client 面的包（声明了 `dsh.client`）从其它 workspace 包导入的**运行时值**，必须逐个在 `scripts/package-dependency-policy.ts` 的 `SAFE_HOST_DEPENDENCY_EXPORTS` 或 `PEER_REQUIRED_HOST_EXPORTS` 里声明，否则门禁报 `is not classified as safe or peer-required`。该文件同时写明：新增条目默认禁止、自动化代理不得添加、每条都要人工评审。

fork 侧当时有六条未分类：`ui-polish` 引 `dsh-home-paths#dshHomePath`、`dsh-llm#BlockAssembler`/`createUserMessage`、`tool-excalidraw#SCENE_RELATIVE`/`sanitizeScene`（后两者从文件面板去重批起就在），`workspace-files` 引 `dsh-fs#FsVersion`。此外四个客户端包的 `peerDependencies` 里除 cordis 外还挂着一批包，与 policy「非 cordis 的 peer 期望归 devDependencies」冲突（含 `ui-ssh`、`ui-sidebar-documentpreview` 两个与本次任务无关的既有红项）。

## 备选方案（各方案优劣）

- **A. 全部登记 `SAFE_HOST_DEPENDENCY_EXPORTS`**：逐条核对实现后按“与实例身份无关”入表。被确认的六条都是纯函数、品牌构造或自建自用的类/常量：`dshHomePath`（路径拼接）、`createUserMessage`（构造消息对象）、`sanitizeScene`（处理 unknown JSON）、`SCENE_RELATIVE`（`join('.dsh','excalidraw','scene.json')` 字符串常量）、`FsVersion`（`v as FsVersion` 品牌断言）、`BlockAssembler`（每处 `new` 后自用，跨包只消费流里的普通对象，全仓无跨包 `instanceof`）。
- **B. 把 `BlockAssembler` 一类登记为 `PEER_REQUIRED_HOST_EXPORTS`**：表内先例是 `SubprocessExecutableNotFoundError`、`SESSION_FORMAT_VERSION`、`scope` 的 Symbol 载体——它们的正确性依赖消费者解析到提供方那一份。`BlockAssembler` 不满足这个条件，登记会得到虚假的契约。
- **C. 改代码消除导入**（例如把 `FsVersion` 改成 `import type`）：`FsVersion` 同时是类型与品牌构造值，`workspace-files` 真的要调用它，改类型导入会让代码编译不过；`BlockAssembler` 也没有替代品。

## 决策（选定方案）

选 A。六条导出登记进 `SAFE_HOST_DEPENDENCY_EXPORTS`，并按 policy 执行 `verify-package-dependencies --fix` 重整四个包的依赖分区。

## 理由（决策依据）

- 分类问的是「安装出第二份副本后，这个值还能用吗」。六条命中都不携带跨实例身份：没有 `instanceof` 判断、没有 Symbol 载体、没有需要跨包一致的版本常量比较。
- 选 B 会把这些导出声明成「必须共享实例」，而实际代码并不需要，反而会把 `ui-polish` 的发布布局锁在 peer 形态。
- policy 的期望分区由分类反向决定（`expectedPackageDependencies`：命中 peer-required 才是 `peer-dev`，否则 `dependencies`），所以分类与 `package.json` 分区必须一起改，只改一边门禁仍是红的。

## 后果（影响与后续）

- `ui-polish`：`peerDependencies` 只剩 `@deepseek-ai/cordis`；`dependencies` 增加 `@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-llm`、`@reachforstar/dsh-tool-excalidraw`（宿主运行时边），`js-yaml` 保留；`@excalidraw/excalidraw`、`@xterm/*` 等浏览器构建输入移入 `devDependencies`。宿主半边构建仍把这些包当外部导入（`productionExternals` 读 dependencies + peerDependencies + optionalDependencies），`lib/index.js` 未内联 `dsh-llm`，行为不变。
- `ui-ssh`、`ui-sidebar-documentpreview`、`workspace-files` 的 peer/依赖分区同批对齐；`docs/module-graph.*` 与 `pnpm-lock.yaml` 由脚本刷新。
- 门禁结果：全仓 67 个包符合依赖策略；门禁仍会打印两类清单——「留在 `dependencies` 的宿主运行时边」与「因导出需要共享身份而留在 peerDependencies 的边」，作为可读的定期复核材料。
- 后续新增跨包值导入时，先判断是否携带实例身份，再决定入哪张表；policy 的人工评审要求不变。
