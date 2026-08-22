# @deepseek-ai/dsh-client-ui-ssh

[English](README.md) | 中文

Web 设置中的 SSH/SFTP 连接管理页：列出已存连接、创建/编辑/删除定义并探测连通性。秘密只写——密码与口令输入框绝不回显已存值。

页面注册 `ssh` 设置段（`order: 30`），通过快照 store（`SshConnectionsStore`）驱动 `ssh` Remote 网关；host 保持单一事实源。

## Model Experience

无——本包仅浏览器。

#### KV Cache effect

无直接影响；从不参与模型请求。

## 已知限制与待办

- **不展示主机密钥**：编辑器不显示主机已记住的指纹（探测结果与 `SSH_HOST_KEY_MISMATCH` 错误携带该事实）。
- **无私钥权限面**：`strictPrivateKeyPermissions` 失败以连接错误呈现。
