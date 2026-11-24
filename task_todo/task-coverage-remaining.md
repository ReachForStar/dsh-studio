# 覆盖率豁免收敛：本次会话（2026-11-24，接 task-coverage-batches.md 游标 29）

游标：豁免 29 → 18。剩余 17 个文件仍列在 [task-coverage-batches.md](task-coverage-batches.md)，逐批推进。

## 本次完成

- [x] 里程碑：批次 E 第三批 A2A 7 个文件（`a2a/src/{bus,client,index,server,task-store}`、`a2a-host/src/{executor,index}`）达标并删豁免（29 → 23）
- [x] 里程碑：批次 A 第二批 `session-format-v3-to-v4/relationships.ts`、`session-persistence-sqlite/{persistence,sqlite}.ts` 达标（23 → 20；关系用例原为 v5 空转，改走 `restoreReleasedV4Artifact`）
- [x] 里程碑：批次 B 第三批 `tool-excalidraw/src/index.ts` 达标（20 → 19）
- [x] 里程碑：批次 H 的 `ui-paper-reader/src/client/PaperReader.tsx` 达标（19 → 18）
- [x] 里程碑：wiki 回写（`queries/fork-gate-debt.md`、`log.md`），`pnpm run test:docs` 21 项全过
- [x] 里程碑：逐包验证（被测包 coverage 100%、`oxlint`、`tsc -b`），四个批次分别提交推送

## 未开始（留在批次游标里，本次会话未展开）

批次 F（远端 SSH/SFTP 4 文件，约 570 处未覆盖记录）、批次 G（CUA 安装 2 文件与 `CuaDriverInstall.tsx`）、批次 H 余项（`ui-a2a-status`、`ui-reference`）、批次 I（`pi-agent-loop` 6 文件）、批次 D（`agent-loop` 死分支与真实 peer 用例）。

## 阻塞项（需外部条件）

- [ ] 阻塞：批次 I 的 `pi-agent-loop` 分支需按 e2e 已验证行为逐条补用例，而 e2e 依赖 AMAX 网关凭据（`AMAX_BASE_URL`／`AMAX_API_KEY`／`AMAX_MODEL`），当前会话未持有
- [ ] 阻塞：批次 G 的 `installer.ts` 与 install 路由要走真实的平台包下载与安装流程，需联网下载并人工确认安装结果