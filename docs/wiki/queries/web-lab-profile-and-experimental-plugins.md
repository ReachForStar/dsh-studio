---
title: 实验能力试验 profile（web-lab）与上游实验插件启用情况
type: query
tags: [profile, 实验插件, browser-use, computer-use, auto-review, 远端工作区]
created: 2026-09-17
updated: 2026-09-18
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

### 三项前置已全部落地并端到端验证（2026-09-17 晚）

| 能力 | 前置 | 端到端证据 |
| --- | --- | --- |
| **Browser Use** | `playwright install chromium`（1.63.0-alpha 对齐 @playwright/mcp@0.0.80，构建 1243 入 `C:\Users\xyx\AppData\Local\ms-playwright\`） | web UI 会话：`browser_navigate`(example.com) → `browser_wait_for`(标题) → `browser_take_screenshot` → `browser_close`，标题 `Example Domain`，46s |
| **Computer Use** | cua-driver 0.28.0（release `cua-driver-rs-v0.28.0` windows-x86_64-binary，装 `C:\Users\xyx\.local\cua\`，`~/.local/bin/cua-driver.cmd` 垫片入 PATH，遥测已关） | web-lab 挂 `computer-use-cua-driver-mcp`（`command` 指本机 exe）；`mcp__cua-driver-mcp__get_desktop_state` 截到 2560×1440 主屏。qwen-3.8-27B 路由未声明图像输入，像素未入模型上下文（预期：非视觉路由收 MCP 桥诊断文本）；截图管线本身可用 |
| **远端 SSH 工作区（模型侧）** | 见下：基于 fork 接缝 `ctx.sshSftp` 的 fs/subprocess provider（独立工程 `packages/remote/{fs-sftp,subprocess-sftp}`，远端只需 OpenSSH，无需 Node/helper） |  provider 已实现并验证（2026-09-18）：42 条定向测试跑在 WSL 真实 `ssh2` 服务器上全通过；`--dump-config` 组合正确、`pnpm dsh --profile web-lab` 启动无激活告警。**Web 端到端未成**：Web 工作区路径由宿主 `node:fs` 校验，远端路径 attach 失败（详见下方踩坑） |

### 未能端到端验证的三项及原因（历史，保留供回溯）

- **Browser Use 真正驱动浏览器**：`@playwright/mcp@0.0.80` 已在包内 `node_modules`（`packages/experimental/browser-use-playwright-mcp/`），但 Playwright 的 Chromium 未下载（`~/.cache/ms-playwright` 不存在）。需要 `npx playwright install chromium`（约 150MB 下载，属依赖安装，需先获同意）。
- **Computer Use 实际操作桌面**：provider（`computer-use-cua-driver-mcp`）启动的是外部二进制 `cua-driver mcp`，本机 PATH 中没有 `cua-driver`，因此只挂了共享能力服务，未挂 provider。
- **远端 SSH 工作区**：上游 `@deepseek-ai/dsh-ssh` 需要远端主机上有 Node 与已部署的 helper（`packages/ssh/ssh` 的 `helper` 入口 + `helperHash`），本机 WSL 里没有 Node、也没有运行中的 sshd，无法实测；而且上游 `docs/subsystems/ssh.md` 明确写着「替换 provider 不会让假设本地文件系统的 Web 视图变成远端感知」——本 fork 的文件面板、SFTP 面板都假设本地文件系统，接上后模型侧可用、Web 侧仍读本机路径。（2026-09-18 更新：WSL 已有 sshd 与 node，fork 自研路线见下一节。）

### 远端工作区：已实现与验证的部分（2026-09-18）

- 两个 provider 包 + `ssh` 接缝新词汇（`openExec` / PTY `command` / `openRead` 窗口）见实体页[远端工作区 provider](../entities/remote-workspace-providers.md)。
- `web-lab` 的 patch 已改为 `disabled` 原行 + `insert` 新行（fs-sftp / subprocess-sftp，均指已保存的 `wsl` 连接，`sandbox-policy.workspaceRoot` 同步指远端），并补上了 `pi-agent-loop`（否则 settings 默认 preset `pi` 导致任何会话创建失败）。
- 未成的一步：以 `/home/xyx/dsh-test` 为工作区路径建 Web 会话时，`workspace/entity.ts` 的 attach 校验走宿主 `node:fs realpath`，报 `session/workspace-attach-failed: its cwd '/home/xyx/dsh-test' does not resolve`。上游 `packages/ssh/ssh` README 第 93 行记录同一限制（Web 工作区 UI 假设宿主文件系统）。因此**要在远端工作区里跑会话，目前只能走 headless / 自定义组合**，不能靠 Web 工作区面板；目录选择器也是宿主本地的，选不到远端目录。

## 涉及模块

- 组合与 profile：`packages/bundle/{base,web-app}`；用户侧 profile 位于 `~/.dsh/profiles/`（仓库外）。
- 实验插件：`packages/experimental/{browser-use-*,computer-use-*,auto-review}`、`packages/browser-use/browser-use`、`packages/computer-use/computer-use`。
- 远端工作区：`packages/remote/{ssh,ssh-local,fs-sftp,subprocess-sftp}`（fork 路线）与 `packages/ssh/{ssh,fs-ssh,subprocess-ssh,sandbox-ssh}`（上游 helper 路线）。

## 复发预防

- 判断「某上游功能为什么看不到」时，先在 `packages/bundle/*/cordis.patch.yml` 里 grep 包名：命中即已挂载，未命中说明是 opt-in 实验包，需要在 profile 里显式挂。
- 挂实验插件一律用独立 profile（`web-lab`），别动 `web`：实验 provider 缺少外部依赖时会激活失败并拖累整份组合的诊断。
- **换 provider 必须 `disabled` + `insert`，不能只写新 `name`**：patch 的 `name` 是命中行插件名校验，不匹配时只警告并跳过（`applyEntryPatches`），`--dump-config` 里仍是旧行。
- 改 profile 后用 `pnpm dsh --profile <name> --dump-config` 自检：跳过/未命中的 patch 都会在这一步打 warning，不必启动整个应用。
- 自建 profile 要能开会话则必须自带 settings 默认 preset 对应的 agent loop（本机默认 `pi` → 记得 `pi-agent-loop`）。
- 远端工作区不能走 Web 工作区：路径校验在宿主文件系统（`packages/workspace/workspace/src/paths.ts`），用 headless / 自定义组合验证。
