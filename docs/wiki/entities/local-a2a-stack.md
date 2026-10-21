---
title: 本地 A2A 联调栈（deploy/a2a）
type: entity
tags: [部署, a2a, kafka, 网关, 启动脚本, 联调]
created: 2026-09-24
updated: 2026-10-21
sources: []
status: active
---

# 本地 A2A 联调栈（deploy/a2a）

本地跑星域三席所需的整套组件，一条命令拉起：Kafka 集群、承载专家席的三台 A2A 网关、Web 应用。入口是 `pnpm run stack:up`（`node deploy/a2a/stack.mjs up`），另有 `stack:status` 与 `stack:down`。

## 职责

| 组件 | 端口 | 来源 |
| --- | --- | --- |
| Kafka 三 broker KRaft 集群 | 9092/9093/9094 | 本仓库 `deploy/a2a/kafka/docker-compose.yml` |
| pi / Claude Code / opencode 网关 | 9310/9320/9330 | 本仓库 `deploy/a2a/gateway`（源码已入库；`A2A_BRIDGE_DIR` 可覆盖） |
| Web 应用 | 3080 | 本仓库 `apps/cli/lib/bin.js`（构建产物） |

## 幂等规则（为什么反复执行是安全的）

- **Kafka**：按 compose 项目 `kafka` 查容器，三个都 `running` 就跳过；否则 `docker compose up -d`。compose 文件固定了 `name: kafka`，所以换目录调用仍归属同一项目、不会起第二套集群。
- **网关**：端口已在监听就跳过，否则只拉起缺的那台。
- **Web**：3080 已在监听就跳过。
- `up` 结束后最多等 30 秒直到所有端口响应，再打印最终状态；`down` 只停本栈记录在 `tmp/a2a-stack/started.json` 的进程，并等端口真正释放后才报告残留。

## 配置单一来源

`deploy/a2a/a2a.config.json` 是网关配置（端口、总线主题、模型、OpenCode 的 skill→agent 映射，无密钥）。`stack:up` 把它导出为 `A2A_CONFIG` 同时交给三台网关与 Web 应用，Web 的 profile patch 从同一变量解析 `a2a.bridge.configPath`，因此一次派发的两端读同一个文件。

## 关键文件

- `deploy/a2a/stack.mjs`：编排脚本（纯 ESM + Node 内置模块，不依赖构建）。
- `deploy/a2a/kafka/docker-compose.yml`：集群定义。
- `deploy/a2a/a2a.config.json`：网关配置。
- `deploy/a2a/gateway/`：三台网关的源码（自 `a2a-bridge` 项目 `fdaf67b1b9c7e5809744a6764707a602be8474ed` 迁入），自带 `package.json` 与锁文件，`npm ci && npm run build` 生成 `packages/*/dist/index.js`；`packages/shared` 是协议与总线实现，`cli/` 是运维命令。
- `tmp/a2a-stack/`：运行期日志（`gw-<name>.log`、`web.log`）与已启动进程记录；`web.log` 里有 Web 应用的 token。

## 在 Linux 上启动

`stack:up` 探测 Docker 时直接调用 `docker`。当前登录会话缺少 `docker` 补充组时该调用失败（`id` 显示组名、`/proc/self/status` 的 `Groups` 不含 docker），脚本回退 `wsl.exe` 并把 Kafka 报成 `unknown`。用 `sg docker` 让组生效再启动：

```sh
set -a && . ./.env && set +a
sg docker -c "node deploy/a2a/stack.mjs up"
```

- 网关运行前必须先在 `deploy/a2a/gateway` 执行 `npm ci`（该目录自带锁文件，是仓库外的独立 npm workspace，`node_modules` 被 `.gitignore` 忽略）。缺依赖时三台网关以 `ERR_MODULE_NOT_FOUND: @a2a-bridge/shared` 退出，而 `stack:up` 已把 PID 记进 `tmp/a2a-stack/started.json`，最终状态只显示 `not listening`，原因在 `tmp/a2a-stack/gw-<name>.log`。
- 首次启动要拉取 `apache/kafka:3.9.0` 镜像（构建/安装超时按 300 秒计）。
- 网关的模型密钥取自仓库根 `.env`（`AMAX_API_KEY`/`AMAX_MODEL`/`AMAX_BASE_URL`）：`stack.mjs` 以 `{...process.env}` 传给子进程，所以先 `source .env` 再启动。
- 9310 同时是 Web 应用 `a2a-host` 的默认端口（`DSH_A2A_PORT`）与 pi 网关端口。[`a2a-host` 的 apply](../../../packages/a2a/a2a-host/src/index.ts) 在端口被占用时跳过启动而不抛 `EADDRINUSE`，因此两者共存：先起的 pi 网关占用 9310，Web 应用不再对外发布自己的 A2A 端点。
- 只读核验用 kafkajs admin 查主题与消费者组；`kafkajs` 只装在 `deploy/a2a/gateway/node_modules`，探针脚本要以该目录为工作目录执行，否则报 `ERR_MODULE_NOT_FOUND`。

## 2026-10-21 状态核验

Kafka 三个容器均为 running。9310 返回 agent card，名称为 `dsh-studio`，不能仅凭端口将其判为 pi 网关；9320、9330 未监听。状态页面只读取当前应用的 `a2aHost.listening`，不代表整台机器的所有 A2A 服务；端口被占用时，本应用会跳过 A2A 主机启动。

## 重要变更记录

- 2026-10-16 在 Linux 上启动并通过核验：修好 `deploy/a2a/gateway` 的依赖（`npm ci` + `npm run build`）后，Kafka 三 broker、三台网关（9310/9320/9330）、Web 应用（3080）全部就绪。实测证据：三张 agent card 返回 HTTP 200（`pi-agent`/`claude-code-agent`/`opencode-agent`）；Kafka 主题 `a2a.task` 6 分区 6 领导、`a2a.event` 6/6、`a2a.dlq` 1/1；消费者组 `pi-gw`/`claude-code-gw`/`opencode-gw` 均为 `Stable` 且各 1 个成员；Web 带 token 访问返回 303。
- 2026-09-24 网关源码入库：三台网关与 `shared`/`cli`/`e2e` 一并迁入 `deploy/a2a/gateway/`；`stack:up` 默认从仓库内路径启动（`A2A_BRIDGE_DIR` 仍可覆盖）。实测：`npm ci`（141 包）+ `npm run build` 通过，栈从仓库内路径拉起三台网关，`node cli/dispatch.mjs --to opencode --skill analysis --input "只回复两字：自洽"` 返回 `TASK_STATE_COMPLETED` 与预期文本。
- 2026-09-24 建立：把原先散在 `D:/file/a2a-bridge/infra` 与手工 `Start-Process` 的启动流程收敛进本仓库；Kafka 与网关按「已运行则跳过」处理，实测过「全停 → 一键拉起 → `/planning` 端到端成功」与「停掉 Kafka → `up` 自动重启集群（容器 6–8 秒恢复）」。

## 关联页面

- [星域多智能体](../entities/xingchen-multi-agent.md)
- [A2A 栈](../entities/a2a-stack.md)
- [启动器改用构建产物面](../decisions/2026-09-24-launcher-artifact-plane.md)（`stack:up` 启动的 Web 应用走同一产物面）
