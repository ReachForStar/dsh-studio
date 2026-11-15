# 修复 lint 既有红项与本机 git 用例超时

## 里程碑

- [x] 里程碑：`pnpm run lint` 0 error（75 条既有红项按规则修正，不靠关闭规则）
  - 七类：多余断言/可选链、`any` 泄漏（excalidraw 场景、`Object.entries` 接口重载）、void 箭头、`require-await`、同构函数、废弃会话读取（生产侧行级豁免 + 测试侧改用投影句柄）、纯格式。
- [x] 里程碑：`experimental/worktree`、`client-ui-forge` 在默认 5 秒超时下全绿（先定位真实耗时来源）
  - 根因：Linux 原生作用域每条命令启动私有 Node runner 约 150ms；lens 用例约 180 条 git 命令。
  - 修法：全局 30 秒测试预算（两个 inline 项目）+ 两个 git 夹具套件文件级 60 秒上限；顺带修 `ui-polish` 四处未清理定时器造成的未处理异常。
- [x] 里程碑：全量 `pnpm exec vitest run`（默认超时）无失败
  - 结果：60692 通过 / 1 既定期望失败 / 274 跳过 / 0 未处理错误，exit 0。
- [x] 里程碑：`typecheck` + `build:check` + `test:docs` 通过
  - `typecheck` 5 门、`build:artifacts` 8 门、`build:check` 2 门、`test:docs` 21 门。
- [x] 里程碑：wiki 更债清单为清零态，`index.md`/`log.md` 同步，提交推送
  - 新增 `queries/lint-debt-clearance-and-local-test-budget.md`，债务页两处 lint 红项标为清偿，合并页补关联。
- [x] 里程碑：本轮 `tmp/` 新增条目清理
  - 仅删除本次新增日志与探针文件。
