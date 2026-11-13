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

opencode 能力清单只剩这一项。本仓库的 `mcp-client` 每个插件实例自行创建 `Client` 与 transport，并在自己的监督器里处理重连、凭据刷新、工具同步与资源订阅；共享连接必须把这套生命周期从实例中抽出交给独立服务，OAuth 则要在同一处补授权跳转、回调与 token 刷新。SDK（`@modelcontextprotocol/client@2.2.0`）已确认导出 `OAuthClientProvider`、`OAuthClientInformation`、`OAuthTokens`、`redirectToAuthorization` 等类型。

## 已完成，不要重做

| 项 | 落点 |
| --- | --- |
| 权限规则求值、静态扫描、项目规则、始终允许、修改后允许 | `packages/interaction/user-approval`、`packages/core/tool-executor-ptc/src/scan.ts`、`packages/client/ui-approval` |
| 会话日志导入 | `packages/session-query/session-log-export/src/importer.ts` |
| PTC SDK 预算目录 | `packages/core/tool-executor-ptc/src/sdk-catalog.ts` |
| 侧问面板（btw） | `packages/experimental/btw` |

清单状态见 [opencode 能力落地交接（余 2 项）](opencode-capability-handoff.md)。

## 现状（代码事实）

- `packages/mcp/mcp-client/src/index.ts`：插件入口，每实例一个 `serverName`；`inject = ['tools']`，连接启动调用 `startConnection`。
- `packages/mcp/mcp-client/src/connection.ts`：连接监督器。`startConnection(ctx, config, policy, status)` 在 `connectGeneration()` 内 `new Client({ name: 'dsh-mcp-client', version: '0.0.1' }, …)`（约 330 行），随后 `McpGeneration` 建 transport（`generation.ts` 第 35 行 `createTransport(config)`）、同步工具、注册资源订阅、按 `reconnect` 策略重连；`ConnectionHandle` 暴露 `ready` 与 `dispose()`，清理受 `closeTimeoutMs` 约束。
- `packages/mcp/mcp-client/src/transport.ts`：`createTransport(config)` 按 `transport` 创建 `StdioClientTransport` 或 `StreamableHTTPClientTransport`。
- `packages/mcp/mcp-client/src/probe.ts`：`probeServer` 启动临时进程/连接探测。
- `packages/mcp/mcp-client/src/credentials.ts`：`${credential:REF}` 模板解析，订阅 `credentials/reference-updated` 触发整代重连（`connection.ts` 约 300 行）。
- `packages/mcp/mcp-manager/src/index.ts`：按 `servers` 配置与外部 `register()` 增删实例，提供 `restart`、`probe`、`reconcile`、`remount`、`unmount`；`ctx.mcpManager` 是它的公开面。
- 配置字段见 `packages/mcp/mcp-client/README.md`：`transport`、`serverName`、`command/args/env/cwd`、`url/headers`、`toolCallTimeoutMs`、`resourceWatchTimeoutMs`、`maxResourceWatchTimeoutMs`、`startupTimeoutMs`、`closeTimeoutMs`、`expandTemplates`、`maxInstructionBytes`、`failOnStartupError`、`reconnect.*`。
- 凭据服务：`packages/credentials/credentials/src/index.ts` 的 `CredentialProvider`（`resolve`、`set`、`readRecord`、`modifyRecord` 等）。
- 测试设施：`InMemoryTransport.createLinkedPair()` 已在 `packages/mcp/mcp-client/tests/generation.spec.ts` 与 `mcp-client.spec.ts` 用于真实握手。

## 待办 1：连接池

目标：同一部署内相同配置的多个 Location/Agent 共用一个已握手连接；最后一个持有者释放时才关闭。

设计要点：

- 新增独立服务（建议 `packages/mcp/mcp-pool`，Host 侧），由 Cordis 上下文持有池表。禁止模块级缓存或 `globalThis` 注册表；`packages/AGENTS.md` 明确共享状态必须有所有者。
- 池键由影响连接行为的全部输入组成：传输类型、命令/参数/工作目录/环境（密钥只取指纹）、URL/头（同样指纹）、`clientInfo`、`protocol`/协商选项、`expandTemplates`、凭据选择。（参考 `tmp/opencode/packages/core/src/mcp/pool.ts` 的 `key()`。）
- 持有者模型：每次 `start` 加入同键槽位，返回该键的 `ConnectionHandle` 等价面；`dispose` 只退租，最后一位关闭槽位。`ready` 要按持有者各自等待，失败对同键所有持有者一起失败。
- 握手失败回退：服务端拒绝共享握手或协商旧协议时，标记该键不可池化，当前与后续持有者各自独占连接，行为与未池化一致；不要静默降级而不记录。参考实现的 `unpoolable` / `legacy` 集合与告警日志可照着做。
- 复用现有监督器的重连与工具同步：优先在 `connection.ts` 内把“取得 Client/transport”替换为“向池申请”，保留 `McpGeneration`、`syncTools`、`ResourceWatchRegistry`、状态单元与 `closeTimeoutMs` 语义。工具注册仍按持有者的 `serverName` 和 scope 进行，共享连接不共享注册表。
- 不要改 `ctx.mcpManager` 的公开方法，除非确有必要；`mcp-manager` 只增加“同名同配置复用”的路径。
- 凭据刷新：`credentials/reference-updated` 目前触发整代重连。池化后同一键的所有持有者共享一次刷新；刷新失败仍按现有策略回退。

验收：

- 两个 scope 用相同配置各启动一个实例，断言只建一次 transport（stdio 只 spawn 一次；HTTP 只握手一次），工具的公开名仍按各自 `serverName` 注册。
- 先释放一个持有者，连接仍可用；最后释放后 transport 关闭且状态单元完成。
- 握手被拒或旧协议时回退独占，两个实例都能工作且有日志。
- 不同键（URL、命令、环境指纹、凭据选择）不共享。
- 重连预算、`closeTimeoutMs`、资源订阅在共享与独占两种模式下行为一致。

## 待办 2：OAuth

目标：远程 MCP 服务器要求 OAuth 时完成授权并持久化 token，之后自动刷新。

设计要点：

- 实现 `OAuthClientProvider`：`redirectUrl`、`clientMetadata`、`clientInformation`、`tokens`、`saveTokens`、`redirectToAuthorization`、`saveCodeVerifier`/`codeVerifier`；需要时实现动态注册回调。字段以 SDK `@modelcontextprotocol/client` 的类型为准（`node_modules` 内 `index.d.mts` 可查）。
- 存储用 `packages/credentials` 的记录 API（`readRecord`/`modifyRecord`/`delete`），键按服务器与授权服务器 issuer 区分；token 不得进入日志或诊断，`mcp-client` 的诊断已做脱敏，沿用同一套。
- 回调走现有 `connection.fetch.register`（参考 `packages/session-query/session-log-export/src/index.ts` 的 `POST /api/session.import`）：注册一个只接受本机授权码的 GET 路由，校验 state/PKCE 后完成交换并关闭页面。
- 授权入口：`mcp-manager` 或新池服务暴露 `authorize(serverName)`；命令行/设置页触发。无浏览器环境要明确失败而不是挂起。
- 与连接生命周期：未授权时连接进入“等待授权”状态，而不是无限重试；授权完成后触发一次该键的重连。
- 不要把 token 写进 `cordis.yml` 或会话日志；`${credential:REF}` 模板继续用于静态密钥。

验收：

- 本地 mock 授权服务器完成 discovery、动态注册、PKCE、code 交换、refresh 与失效重授权。
- token 过期后自动刷新一次并继续调用；刷新失败要求重新授权且状态可诊断。
- 取消授权、错误 state、错误 code、回调路由被非所有者访问均失败关闭。
- 凭据更新事件不再导致重复授权风暴。

## 顺序建议

1. 先抽池（不改 OAuth），用 `InMemoryTransport` 与真实 stdio 服务器各写一组测试；确保现有 MCP 测试全绿。
2. 再实现 OAuth provider 与回调路由，复用池的键与刷新路径。
3. 最后把 Settings/入口接上，补 README 的 Model Experience 与 Known Limitations。

## 约束与验证

- 提交信息 `type(scope): 摘要`；只暂存具体文件；推送 `me/develop`。
- 最小验证：`pnpm run typecheck`、`pnpm exec vitest run packages/mcp`、`pnpm run build:artifacts && pnpm run build:check`、`pnpm run test:docs`；改配置行时跑 `pnpm run verify-cordis-config`（当前有两条既有失败：browser-use 与 computer-use 缺少 experimental MCP 依赖声明，与 MCP 池无关）。
- 每文件覆盖率 100%：新服务与改动文件都要覆盖；`connection.ts` 的分支已很密，优先抽出纯函数（键计算、持有者计数、回退判定）分别测试。
- 参考实现：`tmp/opencode/packages/core/src/mcp/{oauth.ts,pool.ts,socket-client.ts}`、`packages/core/src/mcp/instructions.ts`。
- 不改 `packages/experimental/speculation` 的未提交改动；不删除 `docs/raw/` 既有文件。
