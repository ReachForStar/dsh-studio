# Web 快照通道金样漂移与状态测试修复

## 任务目标
修复 `apps/web/tests` 快照通道中因已提交产品变更（SSH 导航、AMAX 提供方、
ui-polish 通用设置行、移除 `ui-settings-plugin-inventory`）而残留的金样漂移，
以及由此暴露出的 12 个测试自身状态失败，使相关 e2e 在 replay 下全绿。

## 根因（三个独立缺陷）
1. **`settings-chrome.e2e.ts` 残留「插件列表」引用**：`ui-settings-plugin-inventory`
   （只读「插件列表」tab）已从 Web 组合移除，但第一个测试的中文路径仍在点击
   `tab "插件列表"` 并断言 preset 切换器/全局 plane/搜索插件等 inventory 功能。
   该 tab 已不存在，`tab click` 30s 超时，弹窗未关闭，级联导致后续 7 个测试
   「设置 button 被遮罩拦截」。
2. **`plugin-config.e2e.ts` 硬编码旧默认值**：`shell.timeoutMs` 组成默认值
   已从 `60000` 改为 `120000`（`packages/shell/bash-local/src/index.ts`），
   测试仍期望 `60000`，且后续「已保存 12000」用例依赖前一步成功写入而级联失败。
3. **`agent-preset-authoring.e2e.ts` 的 `withPresetRoot` 平台 bug**：用 `/` 硬编码
   拼接与查找 lane 根路径，Windows 上捕获路径用 `\`，`indexOf('/<name>')` 永远
   失配，导致 golden 归一化失效，`created.expected.md` 里残留下一次运行的随机
   临时目录（如 `dsh-web-e2e-presets-SllQ50`），断言 `{{presetRoot}}/my-agent` 失败。

## 干了什么
1. `settings-chrome.e2e.ts`：删除第一个测试里对 inventory 的预设切换器/全局
   plane/搜索/计数断言与 `PLUGINS_EXPECTED` 捕获，改为断言「插件配置」tab
   selected 且「插件列表」tab 不存在（与英语场景一致）；删除 `PLUGINS_EXPECTED`
   与 `PLUGIN_ROW_SELECTOR` 常量、`plugins.expected.md` golden，并更新
   `assertFixtureInventory` 清单为两份 dialog golden。
2. `plugin-config.e2e.ts`：3 处「命令超时（毫秒）」组成默认值 `60000` → `120000`。
3. `agent-preset-authoring.e2e.ts`：`withPresetRoot` 改用 `sep` + `basename(userRoot)`
   匹配平台分隔符，并把替换后的子路径前缀（`\`/`/`）归一化成稳定的
   `{{presetRoot}}/my-agent`，消除随机临时路径泄漏。
4. 以 `DSH_SNAPSHOT=refresh` 重生成受影响 golden，再以 replay 复核。

## 改了什么（相对历史）
- 测试代码：`settings-chrome.e2e.ts`、`plugin-config.e2e.ts`、`agent-preset-authoring.e2e.ts`。
- 金样：`models-settings/*`（前一轮已刷）、`agent-preset-authoring/{created,damaged,section}`、
  `onboarding-deepseek-config/models`、`onboarding-usable-provider/dismissed`、
  `plugin-config/section`、`settings-chrome/{dialog,dialog-en}`；删除 `settings-chrome/plugins`。
- 金样 diff 仅含预期漂移：`SSH 连接` 导航、`AMAX Token Router` 选项、ui-polish
  的「自动压缩上下文/背景图片/模型费率卡」行、压缩比例选项、inventory 行移除、
  以及 `{{presetRoot}}` 路径归一化（无随机路径/时间戳残留）。

## 验证结果
```text
DSH_SNAPSHOT=refresh → agent-preset-authoring + plugin-config: 14 passed
DSH_SNAPSHOT=refresh → settings-chrome: 11 passed
DSH_SNAPSHOT=replay  → 6 文件（agent-preset-authoring / onboarding-deepseek-config /
                       onboarding-usable-provider / plugin-config / settings-chrome /
                       models-settings）: 43 passed, 0 failed
```
这些 e2e 文件在 `apps/web/tsconfig.json` 的 `exclude` 列表中（host/client 双面
Context merge 冲突），不进入 typecheck；语法与运行已由 vitest 的 vite 转译验证。

## 已知问题与风险
- 本次只覆盖已知漂移/失败的文件；Web 快照通道整体（其余 80+ e2e 文件）未全量
  重放。若其他场景也引用过「插件列表」或 `shell.timeoutMs` 旧默认值，需按同样
  方式排查。已知 `rg` 结果未发现其他「插件列表」测试引用。
- `withPresetRoot` 用 `lastIndexOf(' ', …)` 定位路径起点，仍假设临时目录路径不含
  空格（`C:\Users\John Doe\…` 会误判）。现网用户名含空格时需改为更稳的定位。

## 复现与运行
```sh
# 聚焦刷新（任意一个受影响场景）
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.web.config.ts \
  apps/web/tests/settings-chrome.e2e.ts
# 复核
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts \
  apps/web/tests/settings-chrome.e2e.ts
```

## 后续演进方向
1. 若 CI 全量 Web 快照仍有红项，逐一按「金样漂移 vs 状态测试失败」二分处理。
2. 将 `withPresetRoot` 的路径起点定位替换为结构性匹配，消除用户名含空格的隐患。
3. 「添加提供方」本身无产品缺陷（见 `doc/2026-09-04-models-add-button-investigation.md`），
   真实浏览器若仍无响应，先 `pnpm run build` 重建 bundle 后复测。