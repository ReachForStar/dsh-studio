---
title: 星域包实现缺陷与新包门禁接线（2026-09-19）
type: query
tags: [星域, 缺陷, 门禁, doc-sync, lint, 新包接线, fork]
created: 2026-09-19
updated: 2026-09-19
sources: []
status: active
---

# 星域包实现缺陷与新包门禁接线（2026-09-19）

## 问题

`packages/xingchen/xingchen` 与 `presets/xingchen-qiming` 在上一轮实现后未提交、未验证：单测 6 项失败、类型检查 3 处报错，且一个新 fork 包要过的门禁成片红。

## 实现期缺陷（已修）

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 命令派发不进投影；类型错误「`XingchenCommandName` 不可赋给 `XingchenRoleId`」 | 投影用 `XINGCHEN_COMMAND_ROLES`（角色→命令）按命令名查表，方向反了 | 新增 `roleOfCommand(name)`，经 `Object.hasOwn` 在日志边界校验后返回角色 |
| `xingchen.spec.ts`「多个角色信号同时命中」失败 | 实现取「首个达到最高分」的角色，单测规格是「多位专家同分归启明」 | 平局与单信号都返回 `qiming`，并同步 JSDoc |
| Loader 解包后 `name` 为 undefined | 模块缺少 `export const name = 'xingchen'` | 补上（仍不写 default 导出，见[事故记录](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)） |
| 对等端不可达时命令抛出而非落定 | `dispatchCommand` 直接 await 派发 | try/catch 落定为 `{ kind: 'error' }`，文本带对等端原文（`no A2A peer named "pi"`） |
| `presentCall` 未知角色回退分支不可达 | 宿主对 presenter 做软校验，参数不符时返回 `undefined` | 删掉死分支，测试改断言「参数不符回退通用卡片」 |
| 启动即 `z.object(...).partial is not a function` | `Config` 用了 schemastery 不存在的 zod 风格 API | 改为 schemastery 形态：可选字段不加 `.required()`，可选键的 schema 直接声明 |
| 工具角色校验与测试期望冲突 | 参数 schema 的 `enum` 已在校验层拒绝非法角色，`execute` 里的重复校验不可达；测试却期望 `rejects` | 删掉重复校验，测试改断言工具错误信封（`isError` + 文本），空任务校验保留 |
| 测试导入失败（`zod`、`ToolCallId`、`createInboxStub`） | `zod` 与两个 devDependency 未声明 | 补 `zod` 到 dependencies，`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent-loop-testkit` 到 devDependencies |
| lint：`no-unnecessary-condition` / `arrow-parens` / `no-misused-promises` | 类型断言让 `=== undefined` 成为恒假；单参数箭头函数多写括号；`mockImplementation(() => Promise.reject(...))` | 用带 `Object.hasOwn` 的查表函数、去掉括号、改 `mockRejectedValue` |
| `tsc`（宿主聚合，含 tests）5 处 `Object is possibly 'undefined'` | `mock.calls[0][0]` 在 `noUncheckedIndexedAccess` 下可能为空 | 测试加 `sentCall(stub, index)` 辅助函数，缺失即抛错 |

## 新 fork 包的门禁接线清单

实现与文档都在 `packages/xingchen/` 时，以下位置缺一处就有一门红（本次逐项验证）：

1. **类型项目**：`tsconfig.host.json` 加引用；`tsconfig.base.json` 手写 `@reachforstar/dsh-xingchen`（含 `/clear`、`/types`、`/client`）别名——`gen-tsconfig-paths` 只覆盖 `@deepseek-ai/dsh-` 前缀，`verify-cordis-config` 要求插件名能解析到源码。
2. **解析清单**：预设挂载在 `packages/bundle/web-app/cordis.patch.yml`，插件按 `apps/cli/package.json` 与 bundle 清单的并集解析，两处都登记。
3. **配置 JSDoc**：`verify-config-catalog` 要求每个配置字段（含嵌套）都有散文，嵌套对象要拆成具名接口才能挂 JSDoc。
4. **Cordis 图**：`gen-cordis-catalog` 的 `SERVICE_PAGE` 每个服务键一条、`LINK_MAP` 每个签名里的具名类型一条（否则「references unclassified type」）；`gen-doc-graphs` 的 `SERVICE_ROLES` 每个服务一条，fork 包的 `pkg` 用仓库路径（`xingchen/xingchen`）作 owner 标签。
5. **文档三件套**：包 README、分组 README（链子系统页）、`docs/subsystems/xingchen.md` + `.zh.md` + `.i18n.yaml`（`verify-subsystem-pages` 要求分组 README 至少链一个子系统页）。
6. **双语**：包 README 的 `## 概述` / `## 目录` / `### 开发备注` 等标题用中文，但 ToC 与 `<a id>` 保留英文锚点；中文页里的跨页链接必须指向 `*.zh.md`（`verify-translation-pairing` 会逐条检查 locale）；新页与改动页用 `pnpm run verify-translation-pairing --write <pair>` 记录。
7. **生成物**：`gen-config-catalog`、`gen-cordis-catalog`、`gen-doc-graphs`、`gen-persistence-catalog`、`gen-tool-catalog` 任一漂移都红；中文侧目录（`config-catalog.zh.md`、`capability-seams.zh.md`）不生成，要手工补同位置条目。
8. **预设名单**：新增随包预设要更新 `packages/preset/agent-presets/tests/shipped-root.spec.ts` 的 id 列表与各用例的 id 循环。

## 预设激活失败：服务未在 isolate 域内（网页冒烟才发现）

**现象**：单测、typecheck、doc-sync、`verify-cordis-config` 全绿，但 Web 里选「启明 · 星域路由」时弹错并留在原预设：

```
无法切换到「启明 · 星域路由」：row(s) published process-global service(s) [xingchen]; a preset service
must sit behind an `isolate` realm or move to the host composition (presets/xingchen-qiming/agent.cordis.yml)
```

**根因**：预设行的插件 `apply` 里 `ctx.plugin(XingchenService)` 把 `ctx.xingchen` 发布到了根 isolate，而根 isolate 是进程级的；`mountPreset` 事后用 `leakedServices(ctx, fiber)` 拒绘（`rootIsolate[name] === key` 即判泄漏），因为一个预设的服务不能同时服务所有预设。

**修法**：把该行包进 `cordis:group` + `isolate: { xingchen: true }`，与同文件里的 `planMode: true`、`workflowEngine: true` 同型：

```yaml
- id: xingchen
  name: cordis:group
  group: true
  isolate:
    xingchen: true
  config:
    - id: xingchen-router
      name: '@reachforstar/dsh-xingchen'
      config:
        peers: { tianquan: claude-code, yaoguang: pi, tianliang: opencode }
```

**为何现有门禁没拦住**：`verify-cordis-config` 只查行 id 是否同处两个平面与插件能否解析，不查“哪一行提供了哪个服务”；`shipped-root.spec.ts` 只读 YAML，不挂载组合；单测直接 `ctx.plugin(xingchen)`，根本不经过预设挂载。判据是「提供了 `ctx.<key>` 的预设行，必须能看到 `isolate: { <key>: true }` 祖先」。

**避免复发**：新增预设行时，只要它 `provide` 了服务（查包内 `declare module '@deepseek-ai/cordis'` 的 Context 合并）就套 isolate 域；改完预设文件别忘了重启 Web 服务（roster 在启动时扫描根目录）。

## 仍未清偿（归属其他批次）

- `verify-persistence-changes`：`SessionHeader.backend` / `JsonlHeaderLine.backend` 新增可选字段未确认，需按 [persistence 变更流程](../../../docs/cookbook/reviewing-persistence-type-changes.md) 记录并处理版本决定，属 pi 后端批。
- `verify-package-dependencies`：`ui-polish` 引 `@deepseek-ai/dsh-llm#createAssistantMessage` 未分类；分类表要求人工评审，不自动登记。
- `constraints`：`@reachforstar/dsh-a2a*` 三个包的 `repository` 仍指 fork 仓库；`pi-agent-loop` 版本与根版本不一致。
- `verify-config-source-ownership`：`packages/bundle/web-app/cordis.patch.yml` 里 `a2a-host` 的 `apiKey` 仍内联环境变量。
- `verify-cordis-config`：本机 `core.symlinks=false`，`apps/cli/tests/profiles/acp/cordis.yml` 以普通文件检出，读成非数组根——Windows 环境问题，非代码问题。

## 复发预防

- 新建 fork 包时按上面 8 条顺序接线，一次跑 `pnpm run doc-sync && pnpm run lint && pnpm run constraints && pnpm run verify-package-dependencies`。
- 门禁报「unclassified type」「missing service role classification」「no SERVICE_PAGE entry」时，对应表在生成器脚本里，按条目补而不是绕开。
- 中文文档的跨页链接默认写 `*.zh.md`，只把 `<a id>` 与 ToC 链接保留为英文锚点。
