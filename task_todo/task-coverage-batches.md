# 覆盖率豁免收敛：其余批次（2026-11-24）

游标：豁免清单 50 → 46 → 43 → 41 → 40 → 34 → 33 个文件。

- [ ] 批次 A 第二批：`session-format-v3-to-v4/relationships.ts`、`session-persistence-sqlite/{persistence,sqlite}.ts`
- [x] 批次 B 第一批：`fs/index.ts` 与 `fs/text.ts` 补用例并删除豁免（条目整体移除，2 个文件转为强制）
- [x] 批次 B 第二批（`fs-local/src/fsio.ts`）：补宽容匹配与 `removePath` 的失败分支，删除 `removePath` 里与 `fsErrorFromErrno` 重复的错误映射，文件达 100% 并删除豁免
- [ ] 批次 B 第三批：`tool-excalidraw/src/index.ts`（约 47 语句 / 90 分支）
- [x] 批次 C：`xingchen/clear.ts` 与 `skills.ts` 补齐分支用例并转为强制（条目收窄到 `index.ts`）；`index.ts` 再补终止原因、投影线面、空答复、失败释放、命令面派发失败用例，剩工具无 agent、holdRole 与超时释放三处
- [x] 顺带：`session-format-v3-to-v4` 的条目收窄到 `relationships.ts`，`facts.ts` 转为强制
- [x] 批次 D：4/5 完成 —— `workspace`、`api/session-controller`、`client/modules`、`client-runtime` 补用例并删除豁免
- [ ] 阻塞：批次 D 的 `core/agent-loop/src/index.ts` —— `delegateToRegistry` 的字段缺省分支为死分支（唯一调用点必传 `backend`），委派成功路径需要一个真实 `Agent` 句柄，现有夹具只能用被 `verify-no-unknown-casts` 禁止的 `as unknown` 伪造，需先删死分支并由真实 peer 后端用例覆盖
- [x] 批次 E 第一批：`a2a/src/bridge-config.ts` 转为强制（非法 JSON 与缺省端口用例，删掉只可能来自 SyntaxError 的分支）
- [ ] 批次 E 第二批：`a2a/src/{bus,client,index,server,task-store}`、`a2a-host/{executor,index}`、`tool-a2a`
- [ ] 批次 F：远端 SSH/SFTP 4 个文件
- [x] 批次 G 第一批：`cua/src/client/controller.ts` 转为强制
- [ ] 批次 G 第二批：`computer-use-cua-driver-mcp/{index,installer}.ts`（安装路由与安装器约 37 语句）、`CuaDriverInstall.tsx`
- [x] 批次 H 第一批：`ui-sidebar-files` 四个文件、`client-ui-stats/StatsTable.tsx` 转为强制
- [ ] 批次 H 第二批：`CuaDriverInstall.tsx`、`ui-paper-reader` 两个、`ui-a2a-status`（浏览器车道）
- [ ] 批次 I：Pi 循环 8 个文件
- [ ] 里程碑：`test:coverage` 全绿且豁免清单清零