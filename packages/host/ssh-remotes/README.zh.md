# @deepseek-ai/dsh-host-ssh-remotes

[English](README.md) | 中文

Web GUI SSH 连接管理面的 Host Remote 网关：`list`/`save`/`delete` 定义与 `test` 连通性探测，全部经由 `ctx.ssh` 接缝。秘密只写——每个响应都是无秘密视图；省略存储秘密的保存会保留已存值。

网关注册自有 Cordis 服务（`ctx.sshGateway`），wire 命名空间为 `ssh`；浏览器经 `@deepseek-ai/dsh-api-remotes` 以 `ctx.remote.ssh.*` 消费。

## Model Experience

无——本包仅服务浏览器。

#### KV Cache effect

无直接影响；浏览器调用发生在模型请求之外。

## 已知限制与待办

- **列表无推送刷新**：浏览器每次变更后重取；`ssh` 段的外部 `settings.yaml` 编辑无转发事件（页面刷新后收敛）。
