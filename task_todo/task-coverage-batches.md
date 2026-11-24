# 覆盖率豁免收敛：其余批次（2026-11-24）

游标：豁免清单 50 → … → 30 → 29 个文件。

- [x] 批次 A 第二批：`session-format-v3-to-v4/relationships.ts` 的用例原本走错代际（v5 编解码器），改走 `restoreReleasedV4Artifact` 后达标；`session-persistence-sqlite/{persistence,sqlite}.ts` 补删除分叉与独占分段用例
- [x] 批次 B 第一批：`fs/index.ts` 与 `fs/text.ts` 补用例并删除豁免（条目整体移除，2 个文件转为强制）
- [x] 批次 B 第二批（`fs-local/src/fsio.ts`）：补宽容匹配与 `removePath` 的失败分支，删除 `removePath` 里与 `fsErrorFromErrno` 重复的错误映射，文件达 100% 并删除豁免
- [x] 批次 B 第三批：`tool-excalidraw/src/index.ts` 补展示面与退化输入用例后转为强制，删除三处 schema 挡住的死分支
- [x] 批次 C：`xingchen/clear.ts` 与 `skills.ts` 补齐分支用例并转为强制（条目收窄到 `index.ts`）；`index.ts` 再补终止原因、投影线面、空答复、失败释放、命令面派发失败用例，剩工具无 agent、holdRole 与超时释放三处
- [x] 顺带：`session-format-v3-to-v4` 的条目收窄到 `relationships.ts`，`facts.ts` 转为强制
- [x] 批次 D：4/5 完成 —— `workspace`、`api/session-controller`、`client/modules`、`client-runtime` 补用例并删除豁免
- [ ] 阻塞：批次 D 的 `core/agent-loop/src/index.ts` —— `delegateToRegistry` 的字段缺省分支为死分支（唯一调用点必传 `backend`），委派成功路径需要一个真实 `Agent` 句柄，现有夹具只能用被 `verify-no-unknown-casts` 禁止的 `as unknown` 伪造，需先删死分支并由真实 peer 后端用例覆盖
- [x] 批次 E 第一批：`a2a/src/bridge-config.ts` 转为强制（非法 JSON 与缺省端口用例，删掉只可能来自 SyntaxError 的分支）
- [x] 批次 E 第二批：`tool-a2a/src/index.ts` 转为强制（两个工具的调用卡片、skill/workspace 作为 metadata、派发答复缺标识）
- [x] 批次 E 第三批：`a2a/src/{bus,client,index,server,task-store}`、`a2a-host/{executor,index}` 补用例并删豁免，两棵 src 树达标
- [ ] 批次 F：远端 SSH/SFTP 4 个文件
- [x] 批次 G 第一批：`cua/src/client/controller.ts` 转为强制
- [ ] 批次 G 第二批：`computer-use-cua-driver-mcp/{index,installer}.ts`（安装路由与安装器约 37 语句）、`CuaDriverInstall.tsx`
- [x] 批次 H 第一批：`ui-sidebar-files` 四个文件、`client-ui-stats/StatsTable.tsx` 转为强制
- [x] 批次 H 第二批：`ui-paper-reader/src/translate-service.ts` 转为强制（models 路由的 GET、非 GET 405、目录读取失败的 500）
- [ ] 批次 H 第三批：`PaperReader.tsx`（余 localStorage 读取失败与两处已卸载分支）、`CuaDriverInstall.tsx`、`ui-a2a-status`
- [x] 批次 I 第一批：`subagent-pi/{index,run}.ts` 转为强制（启动失败与清理失败的聚合、中止优先于 cwd 诊断）
- [ ] 批次 I 第二批：`pi-agent-loop` 6 个文件（0–88% 覆盖，需按 e2e 已验证行为逐条补）
- [ ] 里程碑：`test:coverage` 全绿且豁免清单清零