# Wiki 操作日志

> 只追加、不修改历史。可用 `grep "^## \[" docs/wiki/log.md | tail -5` 看最近记录。前缀格式：`## [YYYY-MM-DD] <init|feat|fix|query|lint|chore> | <简述>`

## [2026-09-16] init | wiki-memory hook 自动创建知识库骨架

## [2026-09-17] feat | 合并上游 upstream/master 并沉淀知识

- 完成 upstream/master 当次 tip 的全量合并：80 个冲突文件按来源取舍，3400+ 文件自动跟随；`typecheck`、`build`、`test`（除本机负载抖动）与 `test:docs`（20 门禁）通过。
- fork 服务键 `ctx.ssh` → `ctx.sshSftp`（上游新增同名服务）；pi 后端适配上游 agent API；会话 v3 物理头承载 `backend`。
- 新增页面：[合并决策](decisions/2026-09-upstream-sync.md)、[pi 后端](entities/pi-backend.md)、[SSH/SFTP 接缝](concepts/ssh-sftp-seam.md)、[Windows 门禁踩坑](queries/windows-merge-gates.md)。
- `docs/wiki/` 在 `scripts/translation-pairing.manifest.json` 中排除双语配对（中文维护，无英文对侧）。

## [2026-09-17] chore | 迁移 doc/ 历史任务报告入 wiki

- 把 `doc/` 下 11 份 fork 逐日任务报告按主题并入 wiki 查询页：[客户端栈迁移](queries/fork-client-stack-migration.md)、[Web 修复与快照通道](queries/fork-web-ui-repairs.md)、[pi 后端实现历程](queries/pi-backend-implementation.md)；上一轮合并的既有取舍并入[合并决策](decisions/2026-09-upstream-sync.md)。
- 删除 `doc/` 目录，统一知识源为 `docs/wiki/`；原始文本保留在 git 历史中。

## [2026-09-17] query | 归因本机剩余测试失败

- 逐项隔离复跑并归因：`http-proxy`、`subprocess-local` 的 native-windows/windows-inspector、`apps/desktop` macos-signature 均为期限偏紧/负载抖动，放宽 `--testTimeout` 后全通过。
- `shell/pwsh-local` 与 `shell/tool-pwsh` 的 4 个超时/中止用例归因为本机 pwsh 冷启动 ~270ms 慢于用例的 50–100ms 期限（文件与上游逐字节相同，非合并引入）；结论与判定方法记入 [Windows 门禁踩坑](queries/windows-merge-gates.md)。

## [2026-09-17] fix | amax 等无内置目录网关可运行期读取模型目录

- 新增 [llm-pi-ai 实体页](entities/llm-pi-ai.md)：记录提供方路由、`resolveRouteModels` 严格/延迟校验、端点服务路由（`endpointCatalog`）的判定与物化链。
- 根因：`resolveRouteModels` 对无已安装目录且未列 `models` 的路由直接判定不可服务，配置界面的 `/models` 发现结果从不进入运行期解析；`resolveProfiles` 的严格校验还会拦住这类配置的保存。
- 解法：路由事实只构建一次；满足「无 models 列表 + 无已安装目录 + 端点协议可读」即标记端点服务路由，以 deferred 校验放行保存；`PiAiAdapter` 按代（以 profile 映射身份为键）只读取一次，只读操作点名的路由，失败以端点自身故障上报，读取受路由 `timeoutMs` 约束。
- 验证：`llm-pi-ai` 包 356 用例通过、src 覆盖率 100%；`pnpm run test:docs` 20 门禁通过；新增 Agent Note `2026-09-17-runtime-endpoint-catalogs`（双语）。

## [2026-09-17] fix | SSH 面板新建目录缺 recursive

- 根因：`SshPanel.tsx` 的 `handleMkdir` 未传 `recursive`，父目录缺失时 SFTP mkdir 直接失败；网关与 `ssh-local` 的递归实现本就具备。
- 修复：客户端改传 `recursive: true`；结论与 WSL 实测方式记入 [SSH/SFTP 接缝](concepts/ssh-sftp-seam.md)。

## [2026-09-17] fix | 关闭 SSH 终端时释放共享连接

- 根因：网关 `ptyClose` 只关终端通道，共享连接按 definition 池化常驻且网关无关连接方法，为终端建立的连接比终端活得久。
- 解法：网关记录每个 PTY 所在的连接，最后一个持有者关闭（含 shell 自行退出）即关闭连接，exec/SFTP 按需重连；关连接失败只记日志。
- 验证：`ssh-remotes` 网关 10 用例通过（新增 3 个生命周期用例）；测试用 `StubSshService` 扩充为按 id 共享句柄并提供可控 PTY 会话。
- 结论与取舍记入 [SSH/SFTP 接缝](concepts/ssh-sftp-seam.md)，决策回合见 Agent Note `2026-09-17-terminal-releases-ssh-connection`。

## [2026-09-17] feat | 会话宽度改用滑块，费用卡片按工作区聚合

- 问题3b：删除会话列左右两条 40px 拖拽手柄与辉光，新增 `ui-primitives` 的 `Slider`（原生 range，`label` 必填），渲染为滚动区上方长条；范围 `[640, 列宽-176]`，每步发布 CSS 覆盖并存储，localStorage 键与钳制规则不变。新增概念页 [会话内容宽度轴](concepts/conversation-width-axis.md)。
- 需求3：`StatsFloat` 口径从「所在会话」改为「当前工作区全部会话」——工作区经 `useWorkspaces` 反查，各会话 token 取会话列表行的 `tokenUsage` 投影值（当前会话用实时投影），花费按会话计价（持有的消息逐条计价，其余按卡 `default` 估算）。新增实体页 [统计浮层](entities/stats-float.md)。
- 验证：`ui-primitives`/`ui-conversation`/`ui-polish` 定向用例通过；`StatsFloat.tsx` 覆盖率 100%（语句/分支/函数/行）；`pnpm run test:docs` 20 门禁通过；两条 Agent Note 已入库。

## [2026-09-17] feat | 新增 A2A 协议栈（`packages/a2a/`）

- 三个 `@reachforstar/*` 包：`dsh-a2a`（A2A v1.0.1 JSON-RPC + SSE 的 schema/server/client/task-store 与 `a2a` 服务）、`dsh-a2a-host`（agent card、监听器、以会话为后端的 `DshA2AExecutor`）、`dsh-tool-a2a`（`a2a_peers`/`a2a_send`）。零第三方运行时依赖，只用 `node:http`。
- 接线：`bundle/base` 挂 `a2a` 与 `tool-a2a`，`bundle/web-app` 挂 `a2a-host`（默认 `127.0.0.1:9310`，`DSH_A2A_PORT`/`DSH_A2A_API_KEY` 可覆盖）；新包登记进 `tsconfig.host.json`。
- 踩坑：三个包最初带 `export default`，Loader 的 `unwrapExports`（`exports.default ?? exports`）折叠模块后静默丢掉 `inject`/`Config`，启动报 `cannot get property "tools" without inject` 与 `Cannot read properties of undefined (reading 'peers')`；去掉 default 导出后 `pnpm dsh web` 无告警，`/.well-known/agent-card.json`、`/health`、`ListTasks` 实测通过。
- 踩坑：未登记进 `tsconfig.host.json` 时类型感知 lint 无 program，`src` 下值全成 `any`，产生大量 `no-unsafe-assignment` 假报错。
- 详见实体页 [A2A 栈](entities/a2a-stack.md) 与 [Agent Note](../../.agents/notes/implemented/feature/2026-09-17-a2a-endpoint-and-peers.md)。

## [2026-09-17] note | 弃用文件预览增强，改为后续实现文件编辑

- 需求2 的 docx/pptx/视频预览实现（`ui-sidebar-documentpreview` 下 `document/`、`docx/`、`pptx/`、`video/` 与对应测试）按用户要求从工作区移除：上游文件面板已覆盖其余能力，剩余真正缺口是 Word/PowerPoint 预览与文件编辑，其中文件编辑待后续单独实现。
- 该批试运行暴露的 lint/类型问题（`zip.android`、`media-registration` 等）随文件一并撤销，无需保留。

## [2026-09-17] feat | 文件面板支持编辑与保存，并修复两处 fork 缺陷

- 问题1：`@deepseek-ai/dsh-atomic-write` 的 Windows 重试窗口从 ~1.1s 延长到 ~10s（上限 24 次、delay 上限 500ms），修复设置写入 `EPERM 重命名` 失败。
- 问题2：SFTP 读取改为跟随终端连接——宿主新增 `withConnection()`（取连接→执行→无 PTY 持有时关闭），`exec`/`sftp*`/download/upload 全部改走它；客户端删除「选中即列目录」的 eager 行为，终端关闭即清空列表并提示「打开终端后可浏览远程文件」。
- 需求1a/1b：`workspaceFiles.write` + 文档面板编辑器（详见实体页 [文档面板的编辑与保存](entities/document-panel-editing.md)）。
- 踩坑：新增 `@Remote` 方法后必须重跑根构建重新生成 `lib/typert.remote-client.d.ts`，否则客户端类型缺方法；测试目录不在包 tsconfig 内，须用 `tsc -b tsconfig.client.json` 检查。
