---
title: 本地 A2A 联调栈（deploy/a2a）
type: entity
tags: [部署, a2a, kafka, 网关, 启动脚本, 联调]
created: 2026-09-24
updated: 2026-09-24
sources: []
status: active
---

# 本地 A2A 联调栈（deploy/a2a）

本地跑星域三席所需的整套组件，一条命令拉起：Kafka 集群、承载专家席的三台 A2A 网关、Web 应用。入口是 `pnpm run stack:up`（`node deploy/a2a/stack.mjs up`），另有 `stack:status` 与 `stack:down`。

## 职责

| 组件 | 端口 | 来源 |
| --- | --- | --- |
| Kafka 三 broker KRaft 集群 | 9092/9093/9094 | 本仓库 `deploy/a2a/kafka/docker-compose.yml` |
| pi / Claude Code / opencode 网关 | 9310/9320/9330 | 网关检出目录 `A2A_BRIDGE_DIR`（默认 `D:/file/a2a-bridge`） |
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
- `tmp/a2a-stack/`：运行期日志（`gw-<name>.log`、`web.log`）与已启动进程记录；`web.log` 里有 Web 应用的 token。

## 重要变更记录

- 2026-09-24 建立：把原先散在 `D:/file/a2a-bridge/infra` 与手工 `Start-Process` 的启动流程收敛进本仓库；Kafka 与网关按「已运行则跳过」处理，实测过「全停 → 一键拉起 → `/planning` 端到端成功」与「停掉 Kafka → `up` 自动重启集群（容器 6–8 秒恢复）」。

## 关联页面

- [星域多智能体](../entities/xingchen-multi-agent.md)
- [A2A 栈](../entities/a2a-stack.md)
- [启动器改用构建产物面](../decisions/2026-09-24-launcher-artifact-plane.md)（`stack:up` 启动的 Web 应用走同一产物面）
