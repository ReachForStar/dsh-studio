# Agent Note: 按重复安装安全性归类跨包运行时导出

Status: implemented

[English](2026-09-19-runtime-export-classification.md) | 中文

## Problem

`verify-package-dependencies` 要求每个带 Client 面的包（声明了 `dsh.client`）把它从其它 workspace 包导入的每个运行时值，在 `scripts/package-dependency-policy.ts` 里逐条归类。该策略文件写明：新增条目默认禁止，自动化代理不得添加。当时有六条未归类：`ui-polish` 读取 `dshHomePath`、`BlockAssembler`、`createUserMessage`、`SCENE_RELATIVE`、`sanitizeScene`；`workspace-files` 调用 `FsVersion`。另有四个客户端包声明了非 cordis 的 `peerDependencies`，而策略期望它们放在开发依赖里。

## Decision

六条导出登记进 `SAFE_HOST_DEPENDENCY_EXPORTS`。它们各自是纯函数、品牌构造，或一份副本可以自行产生并使用的值：`dshHomePath` 拼接路径片段，`createUserMessage` 构造消息对象，`sanitizeScene` 复制 unknown JSON，`SCENE_RELATIVE` 是拼接出的相对路径，`FsVersion` 断言字符串品牌，`BlockAssembler` 由调用方自行构造并使用，它从 LLM 流里拿到的是普通对象。仓库里没有任何导入跨包副本比较它们、携带 Symbol，或依赖副本间必须一致的版本常量。

随后 `verify-package-dependencies --fix` 重写了 `ui-polish`、`ui-ssh`、`ui-sidebar-documentpreview`、`workspace-files` 的依赖分区：`peerDependencies` 只保留 `@deepseek-ai/cordis`，宿主运行时边移入 `dependencies`，浏览器构建输入移入 `devDependencies`。`ui-polish` 的依赖里新增 `@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-llm`、`@reachforstar/dsh-tool-excalidraw`，其 Excalidraw 与 xterm 相关包改为开发依赖。

## Alternatives considered

**把这些导出归类为 peer-required。** 那张表装的是正确性依赖消费者解析到提供方实例的值：用 `instanceof` 比较的错误类、Symbol 载体、格式版本常量。这六条都不满足该条件，归类还会把 `ui-polish` 锁在其代码并不需要的 peer 形态上。

**改代码去掉导入而不归类。** `FsVersion` 既是类型也是 `workspace-files` 调用的品牌构造，改成仅类型导入会编译不过；`BlockAssembler` 在该包里没有替代品。

**让这六条保持未归类。** 门禁每次运行都会报出来，而带 Client 面的包不能发布一个重复安装行为未声明的跨包运行时值。

## Consequences

`ui-polish` 把宿主运行时边作为普通依赖发布，而宿主半边仍以外部导入引用它们：`productionExternals` 读取 `dependencies`、`peerDependencies`、`optionalDependencies`，因此 `lib/index.js` 保持对 `@deepseek-ai/dsh-llm` 的导入，不会内联。四份 manifest、`pnpm-lock.yaml` 与生成的 `docs/module-graph.*` 一起变动，门禁现在报告 67 个包符合策略。门禁仍会打印两张复核清单——留在普通依赖里的宿主运行时边，以及因导出需要共享身份而留在 `peerDependencies` 的边——因此后续导入会被有意归类，而非默认放行。
