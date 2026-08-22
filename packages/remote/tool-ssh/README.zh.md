# @deepseek-ai/dsh-tool-ssh

[English](README.md) | 中文

`ctx.ssh` 能力接缝的模型面 Consumer。工具：

- **连接管理**：`ssh_connect`（创建或更新定义）、`ssh_connections`（无秘密列表）、`ssh_disconnect`、`ssh_test`。
- **远程执行**：`ssh_exec`（有界输出与超时的前台命令）。
- **SFTP**：`sftp_list`、`sftp_stat`、`sftp_read`（下载）、`sftp_write`（上传）、`sftp_mkdir`、`sftp_rm`、`sftp_rename`。

本地传输路径相对会话工作区解析。连接按定义共享直至 `ssh_disconnect`；主机密钥默认校验、秘密绝不出现在结果中。`ssh_exec` 以终端卡片呈现，其余为通用卡片。

## Model Experience

### 请求上下文与条件

#### 模型所见

十二个工具 schema（名称、必选/可选参数与描述）注册进 `ctx.tools` 并参与提示词装配，与其它工具一致；精确 schema 见生成的 [tool catalog](../../../docs/tool-catalog.zh.md)。`tool:ssh` 提示词段（`order: 106`）追加一行跨调用指引：

##### 该字段的逐字文本（如需）

```markdown
SSH/SFTP tools operate on saved connections: `ssh_connect` persists a definition before `ssh_exec`/`sftp_*` can use it, and connections stay open until `ssh_disconnect`. Verify remote commands before running destructive ones.
```

#### Token 影响

每次工具调用贡献其 JSON 参数到请求；不添加固定上下文块。

#### KV Cache effect

提示词段文本跨调用稳定，不使可复用前缀失效；工具 schema 按部署固定。

## 已知限制与待办

- **无后台远程执行**：`ssh_exec` 仅前台（无 `run_in_background`）；长操作须适配 provider 超时。
- **`sftp_write` 不创建远程父目录**；先使用 `sftp_mkdir`（`recursive`）。
- **本地传输文件不受 sandbox 约束**：`sftp_read`/`sftp_write` 直接读写本地路径，位于 `ctx.fs` 策略世界之外。
- **主机密钥已校验但不向模型展示**：指纹变更呈现为 `SSH_HOST_KEY_MISMATCH`；清除需编辑 settings 文档。
