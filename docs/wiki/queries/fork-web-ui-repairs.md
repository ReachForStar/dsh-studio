---
title: fork Web UI 修复与快照通道（2026-09-04）
type: query
tags: [web, e2e, snapshot, ssh, settings, amax, ui-polish]
created: 2026-09-17
updated: 2026-09-17
sources: []
status: active
---

# fork Web UI 修复与快照通道（2026-09-04）

## 问题

Web 侧三组用户可见问题：设置项（自动压缩阈值、费率卡、背景图）保存后不刷新；SSH 面板不可用；模型页「添加提供方 / 添加自定义提供方」按钮点击无响应。同时 `apps/web/tests` 快照通道存在大面积金样漂移与测试自身失败。

## 根因

| 现象 | 根因 |
| --- | --- |
| 设置保存后 UI 不更新 | 压缩阈值行、费率卡行读取的是一次性 inject 快照，未订阅客户端 store |
| 重复上传背景图预览不变 | 固定 `/bg/current` URL 被客户端同值短路；缺每次上传唯一的缓存版本 |
| SSH 面板不可用 | 仍请求已退役 fork apiproxy 的 `/api/ssh.*` 点号端点，Host 端返回 404 |
| 模型页按钮无响应 | **非产品缺陷**：处理器与禁用条件均正确，现象来自浏览器加载旧 bundle 或加载中短暂禁用态 |
| `settings-chrome.e2e.ts` 首个用例 30s 超时，级联 7 个失败 | 测试仍在点击已移除的「插件列表」tab（`ui-settings-plugin-inventory` 已从 Web 组合移除），弹窗未关导致后续「设置」按钮被遮罩拦截 |
| `plugin-config.e2e.ts` 失败 | 测试硬编码 `shell.timeoutMs` 旧默认值 `60000`（已改为 `120000`），后续用例依赖前一步写入而级联 |
| `agent-preset-authoring.e2e.ts` 金样泄漏随机路径 | `withPresetRoot` 用 `/` 硬编码匹配路径，Windows 捕获路径用 `\` → 归一化失效 |

## 解法

- 设置行（压缩阈值、费率卡、背景图版本）改走客户端 store 订阅；背景图上传响应带唯一版本号。
- Web 用户设置删除不存在的 `agent-presets.default: code`；`llm-pi-ai.providers.amax` 指向 `https://ai.amaxsmp.com/v1`（AMAX 无固定模型目录，仍由其 `/models` 发现并在模型页获取保存）。
- Web 组合移除只读「插件列表」tab，只留可编辑的插件配置页。
- SSH：网关新增命令执行、PTY（open/attach/input/resize/close）与 SFTP（list/stat/mkdir/rm/rename）Remote 方法；上传下载注册为认证后的精确 Fetch 路由；PTY 输出/退出走既有 Remote Event 通道。客户端改由生成的 `ctx.remote.ssh` 调用，并缓冲 PTY 首屏输出到终端挂载完成。
- 快照通道：`settings-chrome.e2e.ts` 改为断言「插件配置」tab 选中且「插件列表」不存在（删除 `plugins.expected.md`）；`plugin-config.e2e.ts` 默认值改 `120000`；`withPresetRoot` 用 `sep` + `basename` 并按平台分隔符归一化为 `{{presetRoot}}/my-agent`。

## 验证

- `models-settings.e2e.ts` 11/11（refresh + replay 复核）；`agent-preset-authoring` + `plugin-config` 14 passed；`settings-chrome` 11 passed；6 个受影响 e2e 文件 replay 43 passed。
- 组件测试 163 passed；定向修复包测试 18 文件 / 203 用例通过；`pnpm run typecheck` 通过。

## 复发预防

- Web 金样刷新流程：`DSH_SNAPSHOT=refresh` 生成 → `DSH_SNAPSHOT=replay` 复核；金样 diff 必须只含预期漂移。
- 组件默认值变更（如 `shell.timeoutMs`）会同时打断 e2e 断言与后续用例链，改默认值时要全局搜 e2e 里的旧值。
- `withPresetRoot` 仍假设临时目录路径不含空格，用户名含空格的主机需换成结构性匹配。
- 「点击无响应」类报告先强制 `pnpm run build` 重建 bundle 再复测，避免把旧产物当产品缺陷。

（原始逐日记录见 git 历史：合并上游前的 `doc/2026-09-04-*.md` 三份文档。）
