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

连接池与 OAuth 都已落地并通过验证。池化由 `@deepseek-ai/dsh-mcp-client/pool` 服务（`ctx.mcpPool`）承担；OAuth 由 `@deepseek-ai/dsh-mcp-client/oauth` 的提供方、回环授权流程与凭据记录承担，`mcpManager.authorize(name)` 是入口。剩余只有可选的 Settings 授权界面。

## 已完成，不要重做

| 项 | 落点 |
| --- | --- |
| 权限规则求值、静态扫描、项目规则、始终允许、修改后允许 | `packages/interaction/user-approval`、`packages/core/tool-executor-ptc/src/scan.ts`、`packages/client/ui-approval` |
| 会话日志导入 | `packages/session-query/session-log-export/src/importer.ts` |
| PTC SDK 预算目录 | `packages/core/tool-executor-ptc/src/sdk-catalog.ts` |
| 侧问面板（btw） | `packages/experimental/btw` |
| MCP 连接池 | `packages/mcp/mcp-client/src/{pool,pool-key,client}.ts`、`generation.ts` 的 `adopt`、`connection.ts` 的 `joinShared`、base 组合行 `mcp-pool` |
| MCP OAuth | `packages/mcp/mcp-client/src/oauth.ts`（`./oauth`）、`transport.ts` 的 `authProvider`、`types.ts` 的 `waiting-authorization`、`mcp-manager` 的 `authorize`/`forgetAuthorization` |

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

## OAuth 落地事实

- 配置：`StreamableHttpConfig.oauth`（`clientId`、`clientSecret`、`scope`、`callbackPort`、`authorizationTimeoutMs`）；`oauthSettings`/`isOAuthServer` 把 schema 产生的空对象视作未配置。
- 存储：授权凭据存为 `credentialKey('mcp-client', 'server-<hash16>')` 的 `GrantRecord`，payload 含 `clientInformation`、`tokens`、`codeVerifier`、`state`、`redirectUri`，由 zod 在读取时校验；写入走 `modifyRecord` 的独占读改写，刷新令牌不会被两个进程同时覆盖。无法解析的记录直接报错并给出清理路径。
- 流程：`beginAuthorization` 在 `127.0.0.1` 绑定回环监听（`callbackPort` 可固定），用 SDK `auth()` 完成 discovery、动态注册（未配 `clientId` 时）、PKCE 与 code 交换；state 用定长比较校验，重复回调返回 409，错误 state 与 `error` 参数都失败关闭，`authorizationTimeoutMs` 与调用方信号都能终止流程。
- 连接：`createOAuthProvider` 交给 `StreamableHTTPClientTransport` 的 `authProvider`；已存令牌时 401 由 SDK 自动刷新。没有令牌时不发起注定失败的握手，直接进入 `waiting-authorization`；刷新被拒后同样回到该状态，不进入重连翻腾。
- 入口：`mcpManager.authorize(name)` 返回要打开的 URL，凭据落盘后重建实例；`forgetAuthorization(name)` 删除凭据并重建。两者都经 Remote 暴露，未授权条目的分类在 `liveshare` 端点表登记为 `owner-only`。
- 池：池键加入 OAuth 客户端身份（`clientId`、`clientSecret` 指纹、`scope`），不同账号不共用连接。
- 安全：token 不进入会话日志、`cordis.yml` 或诊断；`clientSecret` 是字面配置，文档要求用组合文件的环境展开而不是 `${credential:…}` 模板。
- 与原计划的差异：回调没有走 `connection.fetch.register`，改为自建回环监听。回环方案在 headless/ACP 也能用，且不依赖 Web 宿主；代价是远程宿主需要转发端口，已写进 README 限制。
- 测试：`oauth.spec.ts` 21 项（本地 mock 授权服务器覆盖 discovery、动态注册、PKCE、code 交换、刷新、错误 state、`error` 参数、取消、超时、端口占用、重复回调、已存令牌免交互、凭据记录异常），`manager.spec.ts` 3 项（授权、拒绝、清除凭据）。
- 验证：`pnpm run typecheck`、`pnpm exec vitest run packages/mcp`（337 项）、`pnpm run build`、`pnpm run test:docs`、`pnpm run verify-cordis-catalog` 全部通过；`pnpm run verify-cordis-config` 只剩既有两条失败。

## 顺序建议

1. 已完成：抽池，`InMemoryTransport` 与真实 stdio 各一组测试。
2. 已完成：OAuth provider、回环回调、凭据存储与刷新，复用池的键。
3. 剩余：Settings 授权界面（展示 `waiting-authorization`、调用 `authorize`/`forgetAuthorization`、打开返回的 URL）。

## 约束与验证

- 提交信息 `type(scope): 摘要`；只暂存具体文件；推送 `me/develop`。
- 最小验证：`pnpm run typecheck`、`pnpm exec vitest run packages/mcp`、`pnpm run build`、`pnpm run test:docs`；改配置行时跑 `pnpm run verify-cordis-config`（当前有两条既有失败：browser-use 与 computer-use 缺少 experimental MCP 依赖声明）。
- 每文件覆盖率 100%：新服务与改动文件都要覆盖；`connection.ts` 的分支已很密，优先抽出纯函数（键计算、持有者计数、回退判定）分别测试。
- 参考实现：`tmp/opencode/packages/core/src/mcp/{oauth.ts,pool.ts,socket-client.ts}`、`packages/core/src/mcp/instructions.ts`。
- 不改 `packages/experimental/speculation` 的未提交改动；不删除 `docs/raw/` 既有文件。
