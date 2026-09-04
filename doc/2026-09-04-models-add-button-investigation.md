# 模型设置页「添加提供方」按钮排查与快照刷新

## 任务目标
定位 Web 模型设置页「添加提供方」与「添加自定义提供方」按钮点击无响应的问题，
确认是产品缺陷、前端状态、旧构建产物还是数据问题，并给出可证实的结论。

## 结论
两个按钮**不存在产品逻辑缺陷**，点击处理器与禁用条件均正确。用户侧「点击无响应」
最可能的根因是浏览器仍加载了旧构建产物（bundle 未随源码重建），或页面在加载中短暂
处于禁用态。当前源码中按钮行为经组件测试与真实 Web e2e 双重验证均正常。

## 干了什么
1. 核对 `ModelsSection.tsx` 中两个按钮的 disabled 条件与 onClick：
   - 「添加提供方」：`disabled = addable.length === 0 || !state.writable`，
     点击后 `setAdding(true)` + `setEditing(targetOf(first))`，将休眠提供方目录
     展开为下拉选择卡。
   - 「添加自定义提供方」：`disabled = protocols.length === 0 || !state.writable`，
     点击后 `setDeclaring(true)`，渲染 `CustomProviderCard` 创建表单。
2. 核对两条链路的派生数据：
   - `state.writable` 来自 `settings.describe`，`dsh-settings-file` 提供方
     `get writable()` 恒为 `true`（`packages/settings/settings-file/src/index.ts`）。
   - `protocols` 经 `protocolChoices` 读取 `llm-pi-ai` namespace schema 中
     `providers.<probe>.api`，生产 `Config` 使用 `z.union(supportedProtocols())`
     （schemastery，非 zod），`supportedProtocols()` 返回
     `['openai-completions','openai-responses','anthropic-messages']`，
     序列化后节点为 `{ type:'union', list:[{value}] }`，可正确解析。
   - `llm-pi-ai` 由 base bundle 挂载，`amax`/`anthropic`/`minimax-cn` 等休眠提供方
     进入 `addable`，两条按钮在正常加载后均可用。
3. 验证：
   - `packages/client/ui-settings-models/tests/components.client.spec.tsx`、
     `provider-form.client.spec.tsx` 等 163 个组件测试通过；其中
     「cancels the add card back to the add button」「reaches the card from the
     section and returns to the button on cancel」直接覆盖两个按钮点击 → 卡片出现。
   - `apps/web/tests/models-settings.e2e.ts` 真实组合下「添加提供方」链路
     点击 → 打开下拉、选择 minimax-cn 正常。
4. 刷新 `apps/web/tests/expected/models-settings/` 下 4 个全对话框快照
   （`empty`、`configured`、`declared`、`declared-edit`），纳入两处有意变更：
   `SSH 连接` 导航项 + `AMAX Token Router` 提供方选项。
   `DSH_SNAPSHOT=refresh` 后 `models-settings.e2e.ts` 11/11 通过，replay 复核通过。

## 改了什么（相对历史）
- 仅重生成 `apps/web/tests/expected/models-settings/{empty,configured,declared,declared-edit}.expected.md`，
  差异仅含 `button "SSH 连接"` / `text: SSH 连接` / `img`，与 `option "AMAX Token Router"`，
  无其他漂移。
- 本次未改动任何 `packages/` 下产品源码（结论为无产品缺陷）。

## 已知问题与风险
- Web 快照通道整体仍非绿：`SSH 导航`、`AMAX`、`ui-polish` 压缩/费率/背景图行、
  `插件列表` tab 移除等已提交变更同时使以下 golden 过时（本次未一并处理）：
  `agent-preset-authoring`、`onboarding-deepseek-config`、`onboarding-usable-provider`、
  `plugin-config`、`settings-chrome`（含 `dialog-en.expected.md`）。
- 上列文件的刷新尝试暴露出 12 个**测试自身状态**失败（`settings-chrome.e2e.ts` 等
  在弹窗已开时再次点击 `设置` 被遮罩拦截），与 golden 漂移无关，需单独排查
  （疑似重新加载后设置弹窗自动恢复所致）。
- 该整体修复超出本次「添加提供方」范围，未在此轮完成。

## 复现与运行
```sh
# 聚焦 models-settings 快照
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.web.config.ts \
  apps/web/tests/models-settings.e2e.ts
DSH_SNAPSHOT=replay  pnpm exec vitest run --config vitest.web.config.ts \
  apps/web/tests/models-settings.e2e.ts
```

## 后续演进方向
1. 单独处理 Web 快照通道的剩余 golden 漂移与 `settings-chrome` 等文件的状态测试失败。
2. 若用户仍观察到按钮无响应，先 `pnpm run build` 强制重建 browser bundle 后复测。
3. 后续若仍需更明确的证据，可对「添加自定义提供方」在真实组合下补一条端到端断言
   （点击 → `CustomProviderCard` 出现），与组件测试形成闭环。