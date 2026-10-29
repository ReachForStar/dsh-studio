---
title: 本机经 SOCKS5 代理推送 GitHub
type: query
tags: [git, network, proxy, push]
created: 2026-10-29
updated: 2026-10-29
sources: []
status: active
---

# 本机经 SOCKS5 代理推送 GitHub

## 问题

在本机（Linux）向 `me`（`git@github.com:ReachForStar/dsh-studio.git`）推送失败：

- SSH：`ssh: connect to host ssh.github.com port 443: Connection timed out`。
- HTTPS：`gnutls_handshake() failed: The TLS connection was non-properly terminated`；`git -c http.version=HTTP/1.1 ls-remote` 直接挂起。
- `git config http.proxy` / `https.proxy` 为空，环境变量里也没有 HTTP 代理。

## 根因

到 GitHub 的直连在当前网络下不可达；本机 clash-verge（mihomo）在 `127.0.0.1:7890` 提供 SOCKS5 出口，而 git 与 shell 环境都没有指向它。同端口的 HTTP 代理形态不可用（`curl --proxy http://127.0.0.1:7890` 返回 000），`127.0.0.1:7892` 是另一个出口（实测 403 限流）。

## 解法

用 SOCKS5 走 SSH，逐条命令生效、不写 git 配置：

```sh
GIT_SSH_COMMAND="ssh -p 443 -o ProxyCommand='nc -X 5 -x 127.0.0.1:7890 %h %p'" git push me develop
```

先做只读核对再推送：

```sh
GIT_SSH_COMMAND="ssh -p 443 -o ProxyCommand='nc -X 5 -x 127.0.0.1:7890 %h %p'" git ls-remote me refs/heads/master refs/heads/develop
```

要点：`nc -X 5 -x` 是 SOCKS5 转发，`-p 443` 因为该出口可用的是 443；`git` 的 `http.proxy` 对 SSH 远端不起作用，`GIT_SSH_COMMAND` 才会传给 ssh。实测 `ssh -p 443 git@github.com` 经该代理可完成认证。

若要让本机长期免参数，可改 `git config --global core.sshCommand`（或把远端换成 HTTPS 并设 `http.proxy=socks5h://127.0.0.1:7890`）。本页只记录一次性命令，未改全局配置。

## 涉及模块

- git 远端 `me`（`git@github.com:ReachForStar/dsh-studio.git`）与 lefthook 的 `pre-push` 钩子。
- [Windows 侧 .git 迁到 Linux 后 Lefthook 钩子安装被拒](lefthook-hookspath-cross-platform.md)：同一台机器上的钩子配置问题；本页的推送路径仍会触发 lefthook `pre-push`。

## 复发预防

- 推送报连接超时先分辨失败阶段：预推送钩子的 typecheck 只在文件匹配时运行（`docs/wiki` 变更会被跳过，实测 6–12 秒），连接失败紧接在钩子之后，两者不要混为一谈。
- 先用 `git ls-remote` 经代理验证通路，再执行推送；推送成功后用 `git ls-remote` 与 `git rev-list --left-right --count` 双向核对远端与本地是否一致。
- 不因一次超时就改写远端地址或全局代理配置。