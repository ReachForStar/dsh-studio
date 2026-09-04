# Web 设置与 SSH 面板修复

## 任务目标

修复 Web 配置面板中的自动压缩阈值、模型费率卡、动态背景图片、模型提供方配置、插件空白标签页、无效 Agent preset，以及 SSH 面板无法访问的问题；保留 SSH 面板的完整 PTY 与 SFTP 能力。

## 干了什么

背景图片上传响应增加每次上传唯一的缓存版本，避免固定 `/bg/current` 被客户端相同值短路，重复上传后立即更新预览。

自动压缩阈值行和模型费率卡行改为通过客户端 store 读取设置，设置变更后能够重新渲染，不再依赖一次性的 inject 快照。

Web 用户设置删除了不存在的 `agent-presets.default: code`，并为 `llm-pi-ai.providers.amax` 配置 `https://ai.amaxsmp.com/v1`。AMAX 没有固定模型目录，模型仍通过其 `/models` 接口发现。

Web 组合移除了多余的只读插件清单标签页，保留可编辑插件配置页。插件源代码包仍保留，避免影响其他组合。

SSH 网关新增命令执行、PTY 打开与附加、输入、调整窗口、关闭，以及 SFTP 列表、stat、创建、删除、重命名 Remote 方法；文件下载与上传注册为认证后的精确 Fetch 路由。PTY 输出和退出通过现有 Remote Event 通道转发，避免恢复旧的独立 WebSocket 协议。

SSH 客户端不再手写旧的 `/api/ssh.*` 请求，改由生成的 `ctx.remote.ssh` 调用，并缓冲 PTY 首屏输出直到终端挂载完成。

## 改了什么

相对历史版本，SSH 面板从已退役的 fork apiproxy 点号端点迁移到当前 Typert 斜杠 Remote 端点；当前 Host 端不再返回 `/api/ssh.list` 的 404。

插件设置页从“可编辑配置 + 只读清单”两个标签页收敛为仅可编辑配置页，消除了没有内容的第二个标签页。

默认 preset 不再指向不存在的 `code`；现有已经记录 `code` 的旧会话不会被自动改写，需重新打开有效 preset 或删除旧会话。

## 验证结果

`pnpm run typecheck` 通过。

定向测试通过：18 个测试文件、203 个测试用例，覆盖 SSH 网关、Remote 事件、Fetch 路由、ui-polish 和插件设置。

单独的 Host SSH 网关 typecheck、客户端 ui-polish typecheck、Host 构建均通过。

## 已知问题与风险

SSH 的真实连接、认证、主机密钥和远程服务器兼容性仍依赖实际 SSH 环境；本地测试夹具未连接真实服务器。

AMAX 模型列表由账号和服务端返回决定；设置 baseURL 后，仍需在模型设置页执行获取并保存模型。

已经保存为 `code` preset 的旧会话仍携带旧 preset 标识。删除默认配置只影响新会话和不带固定 preset 的恢复路径。

工作区中原有的 `.mimosa/` 未跟踪目录未纳入本次修改。

## 复现与运行

在项目根目录运行 `pnpm dsh web`，使用终端打印的带 `?token=` 地址打开 Web 页面。

在设置中验证自动压缩阈值和费率卡保存；模型页面为 AMAX 执行获取模型并保存；插件页面应只显示插件配置标签页；会话模型切换不应再因默认 `code` preset 报错；SSH 页面应通过 `/api/ssh/list` 及生成的 SSH Remote 端点工作。

验证命令：

```text
pnpm run typecheck
pnpm vitest run packages/host/ssh-remotes/tests/gateway.spec.ts packages/api/remotes/tests/remote-events.host.spec.ts packages/client/connection/tests/fetch-routes.host.spec.ts packages/client/ui-polish/tests packages/client/ui-settings-plugins/tests
```

## 后续演进方向

为 SSH Remote 方法补充独立的 wire 集成测试，覆盖真实请求解码、端点匹配、Fetch 上传下载和 PTY 事件回放。

为 Web 设置增加浏览器级回归测试，直接断言压缩阈值、费率卡和 AMAX 模型目录的保存结果。

为 Agent preset 增加旧会话 preset 缺失时的可操作恢复界面，允许用户选择有效 preset 后再恢复会话。
