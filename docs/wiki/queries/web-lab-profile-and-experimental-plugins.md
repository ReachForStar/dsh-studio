---
title: 实验能力试验 profile（web-lab）与上游实验插件启用情况
type: query
tags: [profile, 实验插件, browser-use, computer-use, auto-review, 远端工作区]
created: 2026-09-17
updated: 2026-09-17
sources: []
status: active
---

# 实验能力试验 profile（web-lab）与上游实验插件启用情况

## 问题

上游 release note 里的 Browser Use / Computer Use / Auto review / 远端 SSH 工作区在本仓库中「有代码但没挂载」，需要确认每一项的可启用性与前置条件。

## 结论

### 已在 `~/.dsh/profiles/web-lab/` 建试验 profile

`web-lab` 复用 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` 两个 bundle，再插入实验行，因此**不影响** `web` profile：

| 行 | 包 | 加载结果 |
| --- | --- | --- |
| `browser-use` | `@deepseek-ai/dsh-browser-use` | ✅ 激活 |
| `browser-use-playwright` | `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`（`mode: launch`、`browser: chromium`） | ✅ 激活（MCP 客户端按会话惰性初始化） |
| `computer-use` | `@deepseek-ai/dsh-computer-use` | ✅ 激活（只挂共享能力服务） |
| `auto-review` | `@deepseek-ai/dsh-experimental-auto-review` | ✅ 激活（依赖 `llm`/`permissionPresets`/`sessions`/`tools`，web 组合均具备） |

启动方式：`pnpm dsh --profile web-lab`。验证方式：拿 `web` 组合同样跑一遍，加载期摘要无 “did not activate”；再临时插入一条不存在的插件（`@deepseek-ai/dsh-does-not-exist`）确认摘要会报 “1 entry did not activate”，证明 patch 确实生效。

### 未能端到端验证的三项及原因

- **Browser Use 真正驱动浏览器**：`@playwright/mcp@0.0.80` 已在包内 `node_modules`（`packages/experimental/browser-use-playwright-mcp/`），但 Playwright 的 Chromium 未下载（`~/.cache/ms-playwright` 不存在）。需要 `npx playwright install chromium`（约 150MB 下载，属依赖安装，需先获同意）。
- **Computer Use 实际操作桌面**：provider（`computer-use-cua-driver-mcp`）启动的是外部二进制 `cua-driver mcp`，本机 PATH 中没有 `cua-driver`，因此只挂了共享能力服务，未挂 provider。
- **远端 SSH 工作区**：上游 `@deepseek-ai/dsh-ssh` 需要远端主机上有 Node 与已部署的 helper（`packages/ssh/ssh` 的 `helper` 入口 + `helperHash`），本机 WSL 里没有 Node、也没有运行中的 sshd，无法实测；而且上游 `docs/subsystems/ssh.md` 明确写着「替换 provider 不会让假设本地文件系统的 Web 视图变成远端感知」——本 fork 的文件面板、SFTP 面板都假设本地文件系统，接上后模型侧可用、Web 侧仍读本机路径。

## 涉及模块

- 组合与 profile：`packages/bundle/{base,web-app}`；用户侧 profile 位于 `~/.dsh/profiles/`（仓库外）。
- 实验插件：`packages/experimental/{browser-use-*,computer-use-*,auto-review}`、`packages/browser-use/browser-use`、`packages/computer-use/computer-use`。
- 远端工作区：`packages/ssh/{ssh,fs-ssh,subprocess-ssh,sandbox-ssh}` 与上游 `docs/subsystems/ssh.md`。

## 复发预防

- 判断「某上游功能为什么看不到」时，先在 `packages/bundle/*/cordis.patch.yml` 里 grep 包名：命中即已挂载，未命中说明是 opt-in 实验包，需要在 profile 里显式挂。
- 挂实验插件一律用独立 profile（`web-lab`），别动 `web`：实验 provider 缺少外部依赖时会激活失败并拖累整份组合的诊断。
