---
title: Agent Plugins v1 加载器（dsh-agent-plugins）
type: entity
tags: [插件生态, 技能, mcp, 可移植格式, 实验包]
created: 2026-11-11
updated: 2026-11-11
sources: []
status: active
---

# Agent Plugins v1 加载器（dsh-agent-plugins）

## 职责

把可移植的 [Agent Plugins v1](https://agent-plugins.org/) 包变成 harness 能力：`skills/<dir>/SKILL.md` 进 `ctx.skills`，根 `mcp.json` 的 `mcpServers` 注册到 `ctx.mcpManager`。只读包文件，唯一写入是每包的 `PLUGIN_DATA` 目录。

落点：`packages/boot/agent-plugins/`，包名 `@deepseek-ai/dsh-agent-plugins`，`inject: ['skills', 'mcpManager']`。

## 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | `Config`（`plugins` / `dataRoot` / `skillRank`）与 `apply`：逐包读 manifest、按需建数据目录、注册 MCP 服务器、注册技能 provider |
| `src/manifest.ts` | `plugin.json` 校验：`$schema` 必须是 `1.0.0` 规范地址，`name` 为 1–64 位小写字母数字与点/连字符（禁止首尾与连写分隔符），`version` 缺省 `1.0.0` |
| `src/skills.ts` | 技能发现与 `SkillProvider`：`name` 必须等于目录名，`description` 1–1024 字符，正文为 frontmatter 之后的 Markdown |
| `src/mcp.ts` | `mcp.json` 校验与注册项：`stdio`（command/args/env/cwd，默认 `cwd = ${PLUGIN_ROOT}`）与 `streamable-http`（url/headers，拒绝客户端保留头），`sse` 与未知传输跳过 |
| `src/paths.ts` | 包含性校验：`realpath` 后必须留在包根；`resolveContainedOrUnusable` 把缺失/不可读/逃逸统一视为组件不可用 |

## 上下游与接缝

- `ctx.skills.registerProvider`：技能候选带 `provider: 'agent-plugins'`（注册表会校验候选的 provider 必须等于注册名）、`source: 'custom'`、`rank` 默认 300（与自定义技能根同级）。
- `ctx.mcpManager.register(name, entry)`：返回幂等 disposer，经 `ctx.effect` 绑定到加载插件的光纤，插件卸载时撤销注册。
- 注册名形如 `<包名>-<条目名>`，仅保留 `[A-Za-z0-9_-]`；超过 MCP 命名空间 32 字符上限时保留前 23 字符加完整名的 8 位 SHA-1 前缀。
- 跨包重名时先注册者胜出并打警告。

## 边界与已知限制

- 只加载技能与 MCP 两类组件；Agent Plugin 的命令、智能体、钩子、上下文、设置、通道、应用一律忽略。
- 配置的路径必须含合法 v1 manifest，否则插件激活失败（配置错误显式报错）；单个组件非法只跳过该组件。
- 激活时读取一次，包变更需重启。
- 不安装、不下载、不对接市场。
- 非缺失类文件系统错误在列举或读取技能时向上抛出，不做降级。
- 逐文件覆盖率 100%；两处原生非缺失类 I/O 失败用带理由的窄 `v8 ignore` 标注。

## 与 qwen-code 的关系

取自 qwen-code 的 `packages/core/src/extension/agent-plugins-v1/`（manifest / mcp / skills / paths 四件）与其设计文档 `docs/design/agent-plugins-v1-native-support.md`；未移植其 Claude/Gemini/Qoder 转换器与市场、安装、网络策略部分。取舍见 [qwen-code 可融入清单](../queries/qwen-code-capability-comparison.md)。

## 待确认

- 是否需要在官方 bundle 中默认挂载（当前只在显式配置时生效）。
- 是否需要 `$schema` 前缀不同的版本给出区分性错误（当前统一按不支持处理）。