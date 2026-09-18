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

## [2026-09-17] feat | 视频预览与费用卡片改版

- 需求1d：新增 `video` 渲染器（`ui-sidebar-documentpreview/src/client/video/`），bytes 模式 `<video controls preload="metadata" playsinline>`，注册 `mp4/m4v/webm/ogv/mov` 并声明为二进制后缀；Blob URL 与图片渲染器同样在卸载/换文件时回收；失败（Blob 创建或播放被拒）给出失败行。3 处测试（媒体类型矩阵、播放器属性、替换字节回收、Blob 失败、播放失败、无完整字节、未声明后缀）。
- 需求2：`StatsFloat` 展示层重做（口径不变）——总额为主视觉、三档占比条 + 图例、token chips、按模型占比行、计时行最后；收起态胶囊带总额 + token 三段。详见实体页 [统计浮层](entities/stats-float.md#视觉分层2026-09-17-改版)。

## [2026-09-17] feat | 文件系统 seam 支持二进制写入；实验能力试验 profile

- `writeBytes` 落到文件系统 seam：基类拒绝（`FS_UNSUPPORTED_BINARY_WRITE`）、`fs-local` 实现（`writeFileAtomic` 接受 `Uint8Array`）、`fs-sandbox` 围栏、`fs-ssh` 错误码透传；`workspaceFiles` 新增 `@Remote writeBytes`（同 `write` 的包含性/上限/版本守卫，另映射 `workspace-file/binary-unsupported`）。相关文件 100% 覆盖。
- 建立 `~/.dsh/profiles/web-lab/`（base + web-app + browser-use/playwright provider/computer-use/auto-review），加载验证通过；三项端到端限制见查询页 [实验能力试验 profile](queries/web-lab-profile-and-experimental-plugins.md)。

## [2026-09-17] feat | Word / PowerPoint 预览与文本级编辑、视频预览、费用卡片改版

- office：文件系统 seam 新增 `writeBytes`（基类拒绝 + `fs-local` 实现 + `fs-sandbox` 围栏 + `fs-ssh` 错误码透传），`workspaceFiles.writeBytes`，客户端 `createWriteFileBytes`/`face.saveBytes`/pane 透出 `saveBytes`；新增 `office/{zip,xml,errors}` 与 `OfficeBody` 外壳、`docx`/`pptx` 渲染器（`fflate` + 局部名 XML 匹配 + 文本叶子替换）。相关文件 100% 覆盖，`test:docs` 20/20。
- 视频渲染器与费用卡片改版的沉淀见对应提交。

## [2026-09-18] feat | 远端工作区 provider（fs-sftp / subprocess-sftp）与 ssh 接缝扩展

- 两个 fork provider 包：`@reachforstar/dsh-fs-sftp`（`ctx.fs`：远端 realpath 标识、`mtime:size:mode` 版本、临时文件 + SFTP rename 原子发布、`ln` 无覆盖创建、按调用沙箱围栏）与 `@reachforstar/dsh-subprocess-sftp`（`ctx.subprocess`：一条 shell 命令含 cwd/env 层、收集/管道 stdio、PTY wrapper 输出 pid 行、`/proc` 前台判定）。远端只需 OpenSSH，无 helper。
- `ssh` 接缝新增 `SshConnection.openExec`（流式全双工非交互通道）、`SshPtyOptions.command`、`SshSftp.openRead(path, {start,end})`；`dsh-fs` 抽出共享文本机制 `text.ts`（二进制/UTF-8/行尾/字面量编辑）。
- 验证：WSL（Ubuntu-22.04，仓库副本 `/home/xyx/dsh-test`）中 new 包 42/42、`ssh-local`+`fs`+`fs-local` 276 通过；对照 HEAD 复现并修复 `ssh-local` 缺密钥时的 `ENOENT` 泄漏与未启动的 cwd 子套件；测试服务器 exec 改 `spawn` + 管道 stdio 转发。
- 踩坑：profile patch 的 `name` 是命中行插件名校验，写不同 name 会被静默跳过（换 provider 必须 `disabled` + `insert`）；Web 工作区路径走宿主 `node:fs` 校验，远端路径 attach 失败，故 Web 端到端未成（上游 ssh README 记录同一限制）。
- 新增实体页 [远端工作区 provider](entities/remote-workspace-providers.md)，更新 [SSH/SFTP 能力接缝](concepts/ssh-sftp-seam.md) 与 [web-lab 试验 profile](queries/web-lab-profile-and-experimental-plugins.md)；代码侧文档：两包 README 双语、`docs/subsystems/ssh-sftp.md`、Agent Note。

## [2026-09-18] chore | 补全 doc-sync/lint 暴露的 JSDoc 与类型标注，盘点门禁红项

- 修掉本批与在途批共 5 类 JSDoc/类型标注缺口：`A2AHostService.store` 与 `TaskStore.list` 显式类型、a2a/office/pi-agent-loop/`fs/text.ts`/两个新 provider 的 `@param`/`@returns`；`verify-export-jsdoc` 全仓库转绿。
- `remote/ssh/tests/stub-service.ts` 两个会话 stub 的重复 `onExit`/`exit`/`close` 抽为共享基类 `StubSession`，消除 `sonarjs(no-identical-functions)`。
- 盘点结论：fork 自研包在 `doc-sync`（A2A 子系统页与类型分类、tool-a2a 目录登记、client/persistence catalog 过期、web-app 内联 `apiKey`）、`lint`（tool-excalidraw、pi-agent-loop 弃用 API）、`constraints`（a2a repository、pi 版本）、依赖分类与 per-file 100% 覆盖率上均有欠账；fork CI 不跑这些门禁。详见 [fork 自研包的门禁红项清单](queries/fork-gate-debt.md)。
- 本批验证：`test:docs` 20/20、`typecheck` 通过、WSL 25 文件 446 测试通过、Windows 68 文件 757 测试通过；两新包覆盖率未达 per-file 100%（73.8%/62.9% 与 80.8%/65.4%）。

## [2026-09-18] fix | 修复文档预览插件在浏览器加载失败，并补构建期序言守卫

- 现象：`pnpm dsh web` 启动后浏览器报 `Failed to load plugins @deepseek-ai/dsh-client-ui-sidebar-documentpreview` / `web boot: 1 entry did not activate`；真实错误被客户端 Loader 写进无人渲染的 logger，需包裹 `__ModuleLoader__.create` 的 `import` 才能看到：`require("module") missed the module table`。
- 根因：office 批（Word/PowerPoint 预览与文本级编辑）为 docx/pptx 引入 `fflate`，而 `fflate` 的 exports 先列 `node` 条件，动态客户端 bundle 解析到 `esm/index.mjs`，其顶层 `createRequire("module")` 被内联进 factory 序言 → 模块表无该词条 → 整个插件 import 失败。
- 修复：`office/zip.ts` 改从 `fflate/browser` 导入；`packages/client/tsdown.client.ts` 新增 `dsh-client-prologue-builtins`（产物序言出现 Node builtin `require` 即构建失败，报错给出浏览器子路径 / `clientPlugins` alias 两条修法），纯函数 `prologueRequires()` 配 3 条用例；规则写入 `packages/client/AGENTS.md` 第 7 条。
- 验证：`pnpm run build:lib:client` 全量客户端面构建通过（守卫对全部 bundle 无假阳性）；浏览器重载无 console 错误、插件激活；`scripts/client-bundle-purity.spec.ts` + `ui-sidebar-documentpreview` + `client/web` 共 49 文件 400 测试通过。

## [2026-09-18] feat | fork 文件面板支持删除（永久删除 + 二次确认）

- 宿主：`packages/client/ui-polish/src/git-service.ts` 新增 `POST /git/delete {cwd, path, recursive?}`——沿用 `resolveRepoPath` 守卫，拒绝工作区根，用 `lstat` 判定类型（符号链接按链接删），文件直接删、目录仅在 `recursive: true` 时连同内容删。
- 客户端：`MutationDiffPanel` 每行加删除按钮 → `Modal` 确认（目录文案点明内容一并删除）→ 删除后重读根与所有已展开层级，并清空被删条目（或其祖先）对应的编辑区选择；中英文案入 locale 字典；新增 `rowDelete`/`deleteDialog` 样式。
- 边界：`/git/*` 位于 `ctx.fs` 接缝与沙箱策略之外（守卫是工作区相对路径）；删除永久不可撤销，已写入包 README 已知限制。
- 验证：宿主 5 组新用例（删除/非空目录拒绝/递归/根拒绝/逃逸）；客户端 3 个新用例（确认拦截、取消不发请求、目录带 recursive）；手工在 `pnpm dsh web` 的文件面板删除 `tmp/` 下临时文件，列表与磁盘同步消失。新增实体页 [fork Web 面板](entities/fork-web-panels.md) 与 Agent Note。

## [2026-09-18] refactor | 移除与右侧栏重复的「文件」标签页

- 现象：顶部「文件」标签页（`MutationDiffPanel`）与内置右侧栏「工作区文件」树（`ui-sidebar-files`）功能重复——同一批文件两棵目录树、两个编辑器。按用户要求保留右侧栏、移除顶部标签页。
- 代码：删除 `MutationDiffPanel.tsx` / `.module.css` 与 `conversation.view` 的 `files` 注册（slot 只剩 `git`/`excalidraw`/`ssh`）、`diff.*` 全部文案；宿主删掉只服务于它的 `POST /git/list` 与同日加入的 `POST /git/delete`（`/git/read`、`/git/write` 保留，Git 面板右列编辑器在用）。
- 连带：同日加入的「永久删除」能力随面板消失（只能从该面板触达），若要保留需从 `ctx.fs` 接缝补 remove（右侧栏树与 `workspaceFiles` Remote 都没有）；`verify-client-ui-i18n` 红项由 8 降到 7；`verify-client-catalog` 跑 `pnpm run gen-client-catalog` 后清偿（从 office 批起就过期）。
- 文档：包 README 双语删掉文件面板条目与永久删除限制、路由表与 slot 表同步；删除 `feature/2026-09-18-file-panel-delete` Agent Note 三件套，新增 `simplification/2026-09-18-remove-duplicate-file-panel`（含备选方案与延期项）；重写实体页 [fork Web 面板](entities/fork-web-panels.md)、更新 index 与 [门禁红项清单](queries/fork-gate-debt.md)。

## [2026-09-18] feat | 删除能力接到 ctx.fs 接缝与右侧栏「工作区文件」树

- 接缝：`ctx.fs.remove(path, opts?, signal?, sandboxPolicy?)`——唯一按**路径**寻址的变更（与 `lstat` 对称，因为 `resolve()` 跟随末段链接，删链接必须绕开 target）；符号链接按链接删、目录仅在 `recursive` 下连内容删、非空目录不带 `recursive` 报新码 `FS_NOT_EMPTY`、返回 `FsRemoveOutcome.kind`；不带版本守卫。
- Provider：`fs-local`（`fsio.removePath`，Node `rm` 不跟随树内链接）、`fs-sandbox`（围栏**父目录**规范化路径）、`fs-ssh` + SSH helper（新增 `fs.remove` 操作，`FS_NOT_EMPTY` 入错误码表）、`fs-sftp`（SFTP `remove` + 父目录围栏）。
- Remote：`workspaceFiles.delete(scope, path, {recursive}, signal)`——`lstat` 探存在、父目录上证明包含性、`FS_NOT_EMPTY` → `workspace-file/not-empty`；命名为 `delete` 而非 `remove`，因为客户端命名空间服务占用 `remove` 作生命周期方法，遮蔽它会让 `@deepseek-ai/dsh-api-remotes` 整个客户端插件启动失败。
- UI：`ui-sidebar-files`（上游包，fork 打补丁）行内删除控件 + `Modal` 二次确认；确认前不发请求，成功后丢行、剪子树层与展开项并重读父层，失败时弹窗保持打开显示映射文案；新增 `paths.ts`（`childPath`/`isUnder`）避免 store↔face 循环导入。
- 踩坑两条（已写入实体页）：Remote 方法名撞命名空间服务时客户端**没有任何控制台报错**，用 `vitest --config vitest.e2e.config.ts packages/api/remotes/tests/built-lib.e2e.ts` 能在 Node 里拿到真实错误；改名 `@Remote` 后必须重建宿主 typert 产物与全部客户端 bundle，否则表现为对话框一直转「正在删除…」而网络面板无请求。
- 验证：Windows 相关包 462 测试 + WSL 48 文件 643 测试通过；`fs/fs`、`fs-local`、`fs-sandbox`、`workspace-files`、`ui-sidebar-files` 触及源码覆盖率 100%；`typecheck`、`test:docs` 20/20 通过，`lint` 无新增；`dsh web` 手工删除文件与含内容目录均成功且磁盘同步消失。新增实体页 [工作区文件删除](entities/workspace-file-deletion.md) 与 Agent Note。

## [2026-09-18] docs | 补齐 A2A 子系统文档并清偿 4 项门禁红项

- 新增 `docs/subsystems/a2a.md`（+ 中文 + i18n）与 `packages/a2a/README.md`（组 README，+ 中文 + i18n），并在 `scripts/gen-cordis-catalog.ts` 登记 `SERVICE_PAGE`/`linkedTypePages`（a2a、a2aHost 与六个 A2A 类型）、`scripts/gen-doc-graphs.ts` 登记两个服务角色、`scripts/gen-tool-catalog.ts` 登记 `tool-a2a`。
- 连带清偿：`verify-doc-graphs`、`verify-tool-catalog`、`verify-client-catalog`、`verify-config-catalog`（a2a-host 的 5 个配置字段补 JSDoc）转绿；`pnpm run doc-sync` 仍余 3 项既有欠账（pi-agent-loop 配置 JSDoc、会话 v3 持久化产物、web-app 内联 apiKey），已更新 [门禁红项清单](queries/fork-gate-debt.md)。
- 生成物同步：`docs/subsystems/{workspace,filesystem,a2a}.md`、`docs/{capability-seams,event-producer-consumer,tool-catalog}.md` 及其中文侧、`packages/extensions/tool-cordis/src/api-catalog.ts`、`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`。
