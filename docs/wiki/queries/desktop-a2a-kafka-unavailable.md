---
title: 桌面版 A2A 状态页报 Kafka 不可用（asar 内 compose 路径）
type: query
tags: [a2a, kafka, asar, electron, 桌面, 打包, 排查]
created: 2026-10-26
updated: 2026-10-26
sources: []
status: active
---

# 桌面版 A2A 状态页报 Kafka 不可用（asar 内 compose 路径）

## 问题

桌面版（Linux，`/opt/DeepSeek Harness`）设置页「A2A 服务」显示：A2A 主机运行中（端口 9310），Kafka 不可用。安装版不会自动恢复 Kafka，也没有任何可用于排查的提示。

## 根因

Kafka 确实停机（三个容器 `Exited (143)`，退出时间 2026-10-23 04:40），但真正的问题是打包后 `ensureKafka` 无法启动它：

1. `packages/a2a/a2a-host/src/kafka-detect.ts` 的默认 compose 路径由 `require.resolve('@reachforstar/dsh-a2a-host/package.json')` 拼出。打包后该路径落在 `app.asar` 内部。
2. `docker compose -f <asar 路径>` 由 docker 子进程执行，普通进程读不到 asar 虚拟文件系统，实测报 `stat .../infra/kafka/.env: not a directory`，退出码 1。同一文件用仓库路径执行退出码 0。
3. `ensureKafka` 的 Docker 分支当时是空 `catch {}`，失败被吞掉，继续尝试 WSL；Linux 上 `isWslAvailable()` 恒为 false（只对 win32 返回真），最终返回 `unavailable`。
4. 状态页只把 `unavailable` 渲染成「不可用」，`kafkaReason` 字段虽然由 Host 生成却从未被组件渲染，用户没有任何线索。

普通 Node 下 `readFileSync` 读 asar 路径报 `ENOTDIR: not a directory`；**Electron 进程的 `fs` 带 asar 补丁，能正常读取**（实测读到 2156 字节）。这正是修复方向：读文件留在本进程，把内容交给 docker。

## 解法

1. **compose 内容经 stdin 传给 docker**：`docker compose -p kafka -f - up -d`，内容由本进程读出后写入子进程 stdin。WSL 分支同理（`bash -lc "docker compose -p kafka -f - up -d"`），顺带消掉了原来 Windows 盘符转 `/mnt/<drive>` 的路径拼接。
2. **固定项目名**：命令里写 `-p kafka`，并在 `infra/kafka/docker-compose.yml` 补 `name: kafka`，使包内启动与 `deploy/a2a/kafka` 落到同一套容器与数据卷（实测解析出的卷名仍是 `kafka_kafka1-data`）。
3. **不再吞错**：`KafkaEnsureResult` 增加 `failure`（`no-runtime` / `start-failed` / `not-listening`）与 `detail`（命令退出码与 stderr），Docker 与 WSL 分支都把原因留下。启动命令返回 0 但 30 秒内 broker 未监听也算 `not-listening`，与命令失败区分开。
4. **wire 词汇改为结构化**：`kafkaReason: string` 换成 `kafkaFailure`（联合类型或 `null`）与 `kafkaDiagnostic`（原始文本）。状态页文案由客户端 locale 字典拥有，符合「客户端 UI 文案归 locale」的约定；Host 不再拼接中文句子。
5. **状态页渲染诊断**：不可用时显示失败类别文案、探测地址（`kafkaBrokers`）与原始诊断；CSS 选择器从 `data-kafka-ready` 改为组件实际输出的 `data-kafka-phase`，颜色规则才真正生效。

## 验证

- 单测：`kafka-detect` 9 项、状态网关 6 项、客户端组件 7 项；`packages/a2a` + `packages/client/ui-a2a-status` 合计 169 项通过。
- 端到端：以 `ELECTRON_RUN_AS_NODE=1` 运行真实 electron 二进制，读取 asar 内 compose → stdin 启动 → 9092/9093/9094 全部监听。修复前同一路径必然失败。
- 类型检查 `tsc -b` 通过；Typert 产物已重生成（`mode: 'strict'` 的 schema 必须与 wire 类型同步）。

## 覆盖率追到 100%（同日）

`kafka-detect.ts` 原先没有测试，覆盖率 48.51%。追到每文件 100% 时按「可控输入」原则补齐，不引入 mock 业务逻辑：

- **子进程**：`spawn` 换成 vitest 假实现，给 `ChildProcess` 实例挂 `PassThrough` 冒充 `stderr`/`stdin`，再用 `child.emit('exit'|'error')` 驱动默认执行器的成功、非零退出码、stderr 为空、启动失败四种结局。
- **端口探测**：起真实监听套接字测「可达」，用保留地址 `192.0.2.1` 触发 500ms 超时，用未监听端口测拒绝。
- **平台分支**：`vi.spyOn(process, 'platform', 'get')` 让 `isWslAvailable` 的 Windows 分支在 Linux 上也能执行。
- **等待循环**：`waitForBrokers` 原先内联调用 `isKafkaRunning`，无法驱动「退避后再探」的路径。`EnsureKafkaOptions` 增加与既有 `dockerAvailable`/`wslAvailable` 对称的 `probe` 注入点，配合 `vi.useFakeTimers()` 覆盖首探成功、退避后成功、退避后仍失败三条路径。

同时修掉一个真实缺陷：`isKafkaRunning` 原先用 `split(':')` 取主机与端口，`:9092` 的空主机名会落到「连本机」而不被拦下（守卫里的 `host === undefined` 是死分支，`split` 永不返回空数组）。改为 `parseBroker` 取最后一个冒号并校验端口为正整数，空主机、缺端口、非数字端口与端口 0 都在发起连接前返回不可达。

五个改动文件（`kafka-detect.ts`、`a2a-status/src/index.ts`、`A2aStatusSection.tsx`、`a2a-status-store.ts`、`locales.ts`）现在语句、分支、函数、行四项均为 100%（172 语句 / 127 分支 / 44 函数 / 144 行），合计 99 项测试覆盖这三个包。

## 涉及模块

- [A2A 栈](../entities/a2a-stack.md)（`dsh-a2a-host`、`dsh-a2a-status`、`dsh-client-ui-a2a-status`）
- [本地 A2A 联调栈](../entities/local-a2a-stack.md)（`deploy/a2a/kafka` 同一项目名）

## 复发预防

- **打包路径不得交给外部进程**：任何会把仓库内文件路径传给 `docker`、`git`、`rg` 等子进程的代码，在桌面版都要先在本进程读出内容或解析到 `app.asar.unpacked`。Electron 能读 asar 不代表子进程能读。
- **`ensureKafka` 的失败必须留证**：空 `catch` 会让「不可用」无法排查。新增启动路径时同步补 `failure` 分类与 `detail`。
- **wire 类型改动要重跑 `tsx scripts/generate-typert.ts`**：Typert 产物按 `mode: 'strict'` 校验返回结构，漏重生成会在运行时拒绝新字段。
- 状态页只有 `kafkaPhase` 三态时不足以定位问题；改动这类指示器时核对「Host 生成的诊断字段是否真被渲染」。
- **探测类代码要预留注入点**：`ensureKafka` 的 `dockerAvailable` / `wslAvailable` / `probe` 都是同一形状的替身入口；新增探测步骤时补同款选项，否则该分支只能靠真实环境命中，覆盖率必然掉红。
- **`spawn` 的假替身要连流一起给**：只 `mockReturnValue(new ChildProcess())` 拿不到 `stderr`/`stdin`，需要 `PassThrough` 挂上去，再 `emit('exit')` 收尾；否则默认执行器的错误收集分支永远不执行。
