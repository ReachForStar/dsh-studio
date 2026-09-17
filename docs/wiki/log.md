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
