# 覆盖率豁免收敛：其余批次（2026-11-24）

游标：豁免清单 50 → 46 → 43 个文件。

- [ ] 批次 A 第二批：`session-format-v3-to-v4/relationships.ts`、`session-persistence-sqlite/{persistence,sqlite}.ts`
- [ ] 批次 B：文件系统 seam 4 个文件（`tool-excalidraw`、`fs/{index,text}`、`fs-local/fsio`）
- [x] 批次 C：`xingchen/clear.ts` 与 `skills.ts` 补齐分支用例并转为强制（条目收窄到 `index.ts`）；`index.ts` 仍豁免
- [x] 顺带：`session-format-v3-to-v4` 的条目收窄到 `relationships.ts`，`facts.ts` 转为强制
- [x] 批次 D：4/5 完成 —— `workspace`、`api/session-controller`、`client/modules`、`client-runtime` 补用例并删除豁免
- [ ] 阻塞：批次 D 的 `core/agent-loop/src/index.ts` —— `delegateToRegistry` 的字段缺省分支为死分支（唯一调用点必传 `backend`），委派成功路径需要一个真实 `Agent` 句柄，现有夹具只能用被 `verify-no-unknown-casts` 禁止的 `as unknown` 伪造，需先删死分支并由真实 peer 后端用例覆盖
- [ ] 批次 E：A2A 9 个文件
- [ ] 批次 F：远端 SSH/SFTP 4 个文件
- [ ] 批次 G：CUA 4 个文件
- [ ] 批次 H：客户端面板 9 个文件
- [ ] 批次 I：Pi 循环 8 个文件
- [ ] 里程碑：`test:coverage` 全绿且豁免清单清零