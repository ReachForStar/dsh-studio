# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

**本仓库是基于官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的自定义分支**：它以官方发布版为基础，并在其上叠加了下一节所述的 Web GUI 打磨、模型面向的白板工具与 Pi 委派后端。所有新增仍以 Cordis 插件形态交付，通过组合挂载，官方核心保持不变。

## 相对官方版本的定制

| 包 | 本分支新增 |
|---|---|
| [`@deepseek-ai/dsh-client-ui-polish`](packages/client/ui-polish/README.zh.md) | Web GUI 打磨：全局背景图片、按模型单价估算每条已结算消息费用的会话统计浮窗（模型费率卡可编辑）、会话视图内的就地文件与 git 面板、内嵌 Excalidraw 白板标签页（与模型的工具共享同一场景）、可配置的自动压缩上下文阈值。 |
| [`@deepseek-ai/dsh-tool-excalidraw`](packages/fs/tool-excalidraw/README.zh.md) | 模型面向的白板工具——`excalidraw_read`、`excalidraw_write`、`excalidraw_draw`、`excalidraw_export`——读写画布标签页渲染的同一工作区场景文件。 |
| [`@deepseek-ai/dsh-subagent-pi`](packages/subagent/subagent-pi/README.zh.md) | 通过 RPC 模式把任务委派给 [Pi 编码 agent](https://github.com/earendil-works/pi) 的子代理提供方；[`pi-dsh` 示例](examples/pi-dsh/README.zh.md)覆盖反向的 Pi→dsh 委派。 |

## 核心特性

- **插件优先的架构。** 每一项能力——agent 循环、工具、沙箱、存储、Web UI——都是一个 Cordis 插件，由 `cordis.yml` patch 层组合而成。部署通过组合而非 fork 来选择自己的技术栈。
- **多运行表面。** 同一棵组合树驱动 [Web UI](docs/user/guide/index.zh.md)、CLI、一次性 headless 任务、ACP 自动化服务器、JSON-RPC SDK 与 Python SDK。
- **完整的 agent 栈。** 带持久化 JSONL 的会话、系统提示、工具注册表、agent 循环、子代理、后台任务、工作流定义与自动上下文压缩。
- **沙箱化执行。** bash/pwsh shell、带 Code Mode 的代码执行运行时、由 bwrap、Landlock 与 Seatbelt 支撑的进程约束接缝——每一项都由逐会话审批与沙箱策略守护。
- **工作区原生工具。** 带观察策略的文件系统读写编辑、git 工作流、模型与 UI 共享的 Excalidraw 白板、web 搜索与抓取、LSP 与技能注册表。
- **会话智能。** 投影读模型（会话统计、token 用量）、历史 SQLite 全文检索、谱系与关系查询、会话日志导出。
- **可扩展表面。** 逐会话组合的 agent 预设、可安装的 `dsh --profile` bundle patch 层、Claude Code 与 Codex 的 hooks 桥、MCP 服务器集成与自修改扩展。
- **用户平面。** 带文件后端的用户设置、凭据引用、人工反馈、目标、计划模式与交互式审批流程。

包清单见 [packages/README.zh.md](packages/README.zh.md)，各部分如何组合见 [docs/architecture.zh.md](docs/architecture.zh.md)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

该路径安装的是官方构建；本分支的定制仅在本仓库源码中可用。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/ReachForStar/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
