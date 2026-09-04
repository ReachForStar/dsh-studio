# Agent Note: SSH PTY and streaming SFTP

Status: implemented

[English](2026-08-24-ssh-pty-streaming-sftp.md) | 中文

## Problem

SSH 能力需要为 Web 面板提供交互式 PTY 会话和流式 SFTP 传输，同时不能暴露凭据或创建第二套传输协议。

## Decision

`ctx.ssh` 通过规范 SSH 能力提供 `openPty`、`openRead` 和 `openWrite`。本地提供方使用 `ssh2` shell 通道实现 PTY，使用 `ssh2` 流实现 SFTP；PTY 输出会为延迟订阅者缓冲，窗口调整不会请求服务器回复。

Host SSH 网关通过规范的 `ssh` Remote 方法提供命令执行、PTY 生命周期和 SFTP 元数据操作。PTY 输出和退出使用共享 Remote Event 通道。认证后的 Fetch 路由流式传输 SFTP 下载和上传，因此传输字节不会经过 RPC 信封或 Host 临时文件。

浏览器 SSH 面板使用生成的 Remote 命名空间和 Fetch 路由。终端附加前会缓冲首屏 PTY 输出，SFTP 导航与终端会话彼此独立。

## Alternatives considered

**恢复独立的 apiproxy 协议。** 否决，因为应用已有生成的 Remote、Remote Event 和认证 Fetch 传输；第二套 WebSocket 协议会重复认证和生命周期处理。

**在 Host 缓存完整文件。** 否决，因为流式 SFTP 保留背压，并避免远程数据产生不必要的本地副本。

**只提供连接管理。** 否决，因为 Web 需求包括交互式 PTY 和 SFTP 操作，而不仅是保存定义和连通性探测。

## Consequences

Web profile 通过一套传输架构提供完整的 SSH 命令、PTY 和 SFTP 能力。PTY 会话需要显式清理；真实服务器兼容性仍取决于 SSH 认证、主机密钥策略和服务器的 SFTP 行为。生成的 SSH Remote 与事件目录是浏览器方法和事件名称的来源。

## Testing

SSH 网关、Remote Event 转发、Fetch 路由注册、本地提供方和浏览器适配器均有定向测试。认证、主机密钥变更、PTY 行为和 SFTP 互操作性仍需真实 SSH 服务器在测试夹具之外验证。
