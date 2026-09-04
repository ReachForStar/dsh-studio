# 文档门禁修复

## 任务目标

修复 README 结构、双语配对、生成目录、生成图表、Markdown 链接、文档换行、Agent Note 格式和源码导出 JSDoc 的门禁问题，使完整 `doc-sync` 通过。

## 干了什么

补齐 SSH 能力相关文档的双语 README、子系统目录、配置目录、工具目录、能力接缝图和事件生产消费矩阵，登记 SSH PTY 事件类型，并同步新增 Pi 与 AMAX 相关文档事实。

修复 Host SSH 网关新增 Remote 方法的参数和返回值 JSDoc，补充 AMAX provider 导出说明，统一生成目录代码块的 LF 换行处理。

重写不符合当前 implemented Agent Note 格式的 SSH PTY/SFTP Note，补齐中文对侧和 `.i18n.yaml` 配对记录；同步受影响的历史双语文档链接与配对记录。

## 改了什么

相对历史版本，配置目录和工具目录包含 `@reachforstar` SSH/Pi 条目，能力接缝图包含 `ctx.ssh` 与 `subagent-pi`，事件矩阵包含 `ssh/pty/output` 和 `ssh/pty/exit`。

包 README 现在具备统一的 frontmatter、Summary/概述、目录、实现说明、模型体验、限制和开发备注结构；中文目录链接指向对应 `.zh.md` 文档。

当前 checkout 不包含旧版 CI workflow 文件，相关文档链接统一指向现有 `.github/workflows/` 目录；不存在的 `examples/pi-dsh` 引用改为 Pi 集成包文档说明。

## 已知问题与风险

真实 SSH 服务器、认证、主机密钥变更、PTY 和 SFTP 互操作仍需要实际环境验证；文档门禁不覆盖这些外部运行条件。

工作区原有的 `.mimosa/` 未跟踪目录未纳入本次提交范围。

## 复现与运行

在项目根目录执行：

```text
pnpm run doc-sync
```

生成目录可单独刷新：

```text
pnpm run gen-config-catalog
pnpm run gen-tool-catalog
pnpm run gen-cordis-catalog
pnpm run gen-doc-graphs
```

## 后续演进方向

为生成图表中文对侧增加更明确的生成区域策略，减少新增包或事件时的手工同步成本；为真实 SSH 连接、PTY 和 SFTP 增加 wire 与浏览器集成验证。
