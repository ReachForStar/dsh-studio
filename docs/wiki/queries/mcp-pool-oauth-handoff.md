---
title: MCP 连接池与 OAuth 交接
type: query
tags: [交接, MCP, 连接池, OAuth, mcp-client, 凭据]
created: 2026-11-13
updated: 2026-11-13
sources: []
status: draft
---

# MCP 连接池与 OAuth 交接

## 一句话结论

连接池已落地并通过验证，opencode 能力清单只剩 MCP OAuth。池化由 `@deepseek-ai/dsh-mcp-client/pool` 服务（`ctx.mcpPool`）承担：解析后连接配置相同的实例共享一个 transport 与一次握手，各自保留工具注册、重连预算与状态。OAuth 按下文「待办」实现。

## 已完成，不要重做

| 项 | 落点 |
| --- | --- |
| 权限规则求值、静态扫描、项目规则、始终允许、修改后允许 | `packages/interaction/user-approval`、`packages/core/tool-executor-ptc/src/scan.ts`、`packages/client/ui-approval` |
| 会话日志导入 | `packages/session-query/session-log-export/src/importer.ts` |
| PTC SDK 预算目录 | `packages/core/tool-executor-ptc/src/sdk-catalog.ts` |
| 侧问面板（btw） | `packages/experimental/btw` |
| MCP 连接池 | `packages/mcp/mcp-client/src/{pool,pool-key,client}.ts`、`generation.ts` 的 `adopt`、`connection.ts` 的 `joinShared`、base 组合行 `mcp-pool` |

清单状态见 [opencode 能力落地交接（余 1 项）](opencode-capability-handoff.md)。

## 连接池落地事实

- 入口：包导出 `./pool` 指向 `lib/types/pool.js`，`tsconfig.base.json` 有同名路径映射；`packages/bundle/base` 的 `mcp-pool` 行挂载一次，所有 profile 生效。没有该行时实例行为与改造前一致。
- 服务面：`ctx.mcpPool.acquire(config, { signal, redact? })` 返回租约或 `undefined`（该配置不共享）。租约提供 `client`、`onClose`、`onToolsChanged`、`onResourceUpdated` 与 `release()`；最后一个持有者释放时关闭 transport。
- 池键（`poolKey`）：传输类型、`command`/`args`/`cwd`/`env` 指纹（stdio）或 `url`/`headers` 指纹（streamable-http）、`startupTimeoutMs`、`closeTimeoutMs`。环境与头的值只以 SHA-256 指纹入键；`serverName` 不在键内，所以不同命名空间的同一服务器仍共享连接。
- 回退：共享握手失败或 transport 无法创建时，池记录一条警告并把该键标记为进程内不可共享；该实例立即改用独占连接，后续实例直接独占。池不重试共享握手。
- 协议：`versionNegotiation: auto` 同时用于共享与独占连接，旧协议正常降级共享；原计划的 legacy 特判没有对应物，已删除。
- 重连：仍由每个实例的监督器负责。共享连接断开时池移除槽位并通知每个持有者，各持有者按自己的策略重连；先重连者创建新槽位，其余实例随后加入同一槽位。
- 资源更新：共享客户端只注册一次 `notifications/resources/updated` 处理函数，再转发给各持有者的 `ResourceWatchRegistry`（该注册表用 `installHandler: false` 跳过自注册）。等待上限仍按实例配置。
- 凭据：每个实例自行解析 `${credential:REF}`；解析结果进入池键，值相同的实例自然加入同一槽位，值变化时各自换键重连。
- 工具：注册仍按各实例的 `serverName` 与作用域进行，共享连接不共享注册表。

### 与原计划的差异

- 原计划新建 `packages/mcp/mcp-pool`，实际改为 mcp-client 的 `./pool` 子路径服务。池必须复用 `McpGeneration`、`createTransport` 与监督器的客户端构造；独立包只能复制连接内核或形成反向依赖。
- 「握手被拒或旧协议回退独占」简化为「握手失败回退独占」：共享握手与独占握手完全相同，没有可拒绝的共享专用步骤；旧协议由自动协商正常共享。

### 验证

- `pool.spec.ts` 23 项：池键、单 transport 共享、工具与资源通知转发、共享连接丢失通知、握手失败回退、transport 创建失败、不同键不共享、取消等待、槽位替换、服务释放、清理失败诊断、通知处理函数归属。
- `pool-stdio.spec.ts` 1 项：真实 stdio 服务器下两个实例不新增进程；基线由单实例确定，因为自动协商可能额外启动探测进程。
- `packages/mcp/mcp-manager/tests/manager.spec.ts` 的 restart 断言改为等待替代客户端出现：管理器不等待子实例激活，凭据解析使客户端构造晚于重启返回。
- `pnpm run typecheck`、`pnpm exec vitest run packages/mcp`（312 项）、`pnpm run build`、`pnpm run test:docs`、`pnpm run verify-translation-pairing` 全部通过。`pnpm run verify-cordis-config` 只剩既有两条失败（browser-use 与 computer-use 缺少 experimental MCP 依赖声明）。

## 待办：OAuth

目标：远程 MCP 服务器要求 OAuth 时完成授权并持久化 token，之后自动刷新。

设计要点：

- 实现 `OAuthClientProvider`：`redirectUrl`、`clientMetadata`、`clientInformation`、`tokens`、`saveTokens`、`redirectToAuthorization`、`saveCodeVerifier`/`codeVerifier`；需要时实现动态注册回调。字段以 SDK `@modelcontextprotocol/client` 的类型为准（`node_modules` 内 `index.d.mts` 可查）。
- 存储用 `packages/credentials` 的记录 API（`readRecord`/`modifyRecord`/`delete`），键按服务器与授权服务器 issuer 区分；token 不得进入日志或诊断，`mcp-client` 的诊断已做脱敏，沿用同一套。
- 回调走现有 `connection.fetch.register`（参考 `packages/session-query/session-log-export/src/index.ts` 的 `POST /api/session.import`）：注册一个只接受本机授权码的 GET 路由，校验 state/PKCE 后完成交换并关闭页面。
- 授权入口：`mcp-manager` 或池服务暴露 `authorize(serverName)`；命令行/设置页触发。无浏览器环境要明确失败而不是挂起。
- 与连接生命周期：未授权时连接进入「等待授权」状态，而不是无限重试；授权完成后触发一次该键的重连。
- 池键要加入凭据选择（当前只由解析后的传输值体现），同一服务器不同账号不能共享连接。
- 不要把 token 写进 `cordis.yml` 或会话日志；`${credential:REF}` 模板继续用于静态密钥。

验收：

- 本地 mock 授权服务器完成 discovery、动态注册、PKCE、code 交换、refresh 与失效重授权。
- token 过期后自动刷新一次并继续调用；刷新失败要求重新授权且状态可诊断。
- 取消授权、错误 state、错误 code、回调路由被非所有者访问均失败关闭。
- 凭据更新事件不再导致重复授权风暴。

## 顺序建议

1. 已完成：抽池，`InMemoryTransport` 与真实 stdio 各一组测试，现有 MCP 测试全绿。
2. 下一步：实现 OAuth provider 与回调路由，复用池的键与刷新路径。
3. 最后把 Settings/入口接上，补 README 的 Model Experience 与 Known Limitations。

## 约束与验证

- 提交信息 `type(scope): 摘要`；只暂存具体文件；推送 `me/develop`。
- 最小验证：`pnpm run typecheck`、`pnpm exec vitest run packages/mcp`、`pnpm run build`、`pnpm run test:docs`；改配置行时跑 `pnpm run verify-cordis-config`（当前有两条既有失败：browser-use 与 computer-use 缺少 experimental MCP 依赖声明）。
- 每文件覆盖率 100%：新服务与改动文件都要覆盖；`connection.ts` 的分支已很密，优先抽出纯函数（键计算、持有者计数、回退判定）分别测试。
- 参考实现：`tmp/opencode/packages/core/src/mcp/{oauth.ts,pool.ts,socket-client.ts}`、`packages/core/src/mcp/instructions.ts`。
- 不改 `packages/experimental/speculation` 的未提交改动；不删除 `docs/raw/` 既有文件。
