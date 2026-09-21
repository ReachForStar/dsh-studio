# 本地 A2A 联调栈

[English](README.md) | 中文

一条命令拉起本地评审／缺陷／计划三席位所依赖的全套组件：A2A 总线所用的 Kafka 集群、承载专家席的三台 A2A 网关，以及 Web 应用。**`up` 只启动尚未运行的部分**——容器状态为 `running` 时跳过，网关端口已在监听时跳过，Web 应用端口已在监听时跳过。

```sh
pnpm run stack:up       # Kafka (skip if up) → three gateways → Web app
pnpm run stack:status   # report each component; changes nothing
pnpm run stack:down     # stop gateways and Web app started by stack:up
pnpm run stack:down --kafka      # also stop the Kafka cluster
```

`stack:up` 最多等待 30 秒直到所有端口响应，随后打印最终状态。日志写入 `tmp/a2a-stack/`：每台网关一个文件，Web 应用见 `web.log`；Web 启动时打印的 token 也在 `tmp/a2a-stack/web.log` 中。

## 组件

| 组件 | 端口 | 来源 |
| --- | --- | --- |
| Kafka 三 broker KRaft 集群 | 9092 / 9093 / 9094 | 本仓库 `kafka/docker-compose.yml` |
| pi 网关 | 9310 | `gateway/`（源码已入库；`A2A_BRIDGE_DIR` 可覆盖） |
| Claude Code 网关 | 9320 | `gateway/`（源码已入库） |
| opencode 网关 | 9330 | `gateway/`（源码已入库） |
| Web 应用 | 3080 | 本仓库 `apps/cli/lib/bin.js` |

## 配置

`a2a.config.json` 是网关配置：端口、总线主题、模型，以及 OpenCode 的 skill 到 agent 的映射。`stack:up` 把它导出为 `A2A_CONFIG` 交给网关与 Web 应用，因此一次派发的两端读同一个文件。Web 的 profile patch 从同一变量解析 `a2a.bridge.configPath`，其默认值指向网关检出目录。

环境变量覆盖：

| 变量 | 含义 | 默认值 |
| --- | --- | --- |
| `A2A_BRIDGE_DIR` | 提供 `packages/*/dist/index.js` 的网关目录 | `deploy/a2a/gateway` |
| `A2A_CONFIG` | 网关配置路径 | `deploy/a2a/a2a.config.json`（由启动器设置） |
| `A2A_BUS_BOOTSTRAP` | 网关使用的 Kafka bootstrap 地址 | 取配置文件中的值 |
| `A2A_API_KEY` | 网关 HTTP 端点的 bearer 令牌 | 空（仅回环地址可用） |

compose 文件固定了 `name: kafka`，因此无论从哪个目录调用，集群都归属同一个 Docker Compose 项目；先前从其它检出目录启动的容器会被 `stack:up` 视为同一套集群。

## 前置条件

- Docker 可直接访问或经 WSL 访问；启动器会依次探测并采用可用的那一种。
- 网关已构建：在 `deploy/a2a/gateway` 执行 `npm ci && npm run build` 生成 `stack:up` 所启动的 `dist/` 入口。缺失时启动器会指出该路径并跳过对应网关。
- Web 应用已构建：`pnpm run build` 生成 `apps/cli/lib/bin.js`。

## 故障排查

- **某网关 30 秒后仍未响应**——查看 `tmp/a2a-stack/gw-<名称>.log`；缺少模型密钥或检出目录未构建都会记录在那里。
- **命令一直停在 `WORKING`**——席位正在远端执行；网关日志里有模型与逐任务输出。
- **`stack:down` 后端口仍被占用**——那些进程由本栈之外启动；报告会列出它没有接管的端口。
