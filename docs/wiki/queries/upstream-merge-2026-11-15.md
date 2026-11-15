---
title: 合并上游 upstream/master（2026-11-15，0.2.2-rc.3 同步）
type: query
tags: [upstream-merge, v5, 会话格式, 摘要回退, 目录生成]
created: 2026-11-15
updated: 2026-11-15
sources: []
status: active
---

# 合并上游 upstream/master（2026-11-15，0.2.2-rc.3 同步）

## 一句话状态

上游 `dsh-v0.2.2-rc.3` 线已合入，冲突按既有口径全部解决，剩余失败逐项判定为「测试按 fork 语义适配」或「合并引入的真实缺陷」并修完；`typecheck`、`build:artifacts`、`build:check`、`test:docs`、全量测试均转绿，`develop` 已合入 `master` 并推送。

## 起点与终点

- 起点：`me/develop` 与 `me/master` 同在上一个功能提交「新增模型请求观测点」之上。
- 上游目标：`upstream/master` 的 `dsh-v0.2.2-rc.3` 线，94 个冲突文件。
- 本地合并期间的 8 个提交（按主题）：合并上游、恢复删除与二进制写入与镜像回退、会话格式 v5 写者适配、桌面 flock 探测、完全访问审批桩、参数修复语义、星域与 Pi 预设文案、目录与客户端清单重生成。
- 本轮新增：摘要回退修复、工具目录签名统一、双语配对与持久化格式引用重记、版本对齐到 `0.2.2-rc.3`、本页与 `log.md`。
- 版本对齐：合并把家族版本带到上游最新 `0.2.2-rc.3`，fork 自研的 33 个清单仍停在 `0.2.2-alpha.2`/`0.2.2-rc.2`；用 `pnpm run release:dsh -- 0.2.2-rc.3` 一次性对齐（416 个成员，含私有清单与工作区根）。本地 `dsh-v0.2.2-rc.3` 标签由 fetch 指向上游发布提交，真正发布时须按发布流程移到 fork 的发布提交。

## 冲突处理口径（沿用既有策略）

1. **生成物取上游后重生成**：`docs/config-catalog.*`、`event-producer-consumer.*`、`module-graph.*`、`persistence-catalog.*`、`tool-catalog.*`、`slot-catalog.ts`、`pnpm-lock.yaml` 不手工合并，取上游后跑 `gen-*` 与 `pnpm install`。
2. **CI 工作流保留 fork 的删除**：上游的 `ci.yml`、`ci-master.yml`、`e2e.yml`、`release-publish.yml`、`release.yml` 与对应自托管 spec 保持删除。
3. **上游删除的能力整体采纳**：Python PTC（`py-types.ts`、`py-types.spec.ts`、`ptc-python-turn` 快照、`packages/experimental/ptc-runtime-python`）与 `ptc-runtime-python` 的导出一并移除。
4. **包清单与路径表取并集**：`apps/cli`、`apps/desktop`、`hooks-claude-code`、`tsconfig.base.json` 保留 fork 依赖与别名（btw、http-cassette、react 回退、webhook 旧路径）并补上游新增项。
5. **源码按来源意图合并**：上游重构与 fork 功能同时保留（compaction 的 `answeredRoute` + 窗口重置/熔断/回退；fs-local 删除与 `writeBytes`；worktree 镜像；web-fetch 域名清单 + 传输失败分类；client 样式工厂 + fork 构建插件）。
6. **测试按 fork 语义适配**：上游测试假设「当前代」是 v4、参数非法即拒绝、菜单无 fork 项；fork 的写入器是 v5、带参数修复、带自研菜单项。

## 本轮修复与判定

| 失败集群 | 判定 | 修法 |
| --- | --- | --- |
| `session-persistence-jsonl` 的 `catalog-migration` 与 `fork-delivery`（28 项） | 测试按 v5 写入器适配 | 上游把「当前代」写成 4、「未来代」写成 5；fork 写入器是 v5，故当前代改 5、未来代改 6。`fork-delivery` 的投递标记版本同理由 4 改 5，否则校验按「非当前代」跳过 |
| `compaction-image-offload`（4 项） | 合并暴露的真实缺陷 | 摘要模型回退拦截了 `IMAGE_OFFLOAD_REQUIRED`，使图像卸载修复（`compaction/summary-error` 监听器拥有）被跳过、同一失败被重复一次。回退改为不拦截该错误，并在目标与路由相同时不重试 |
| `compaction-basic` 默认值断言 | 合并丢失 fork 断言 | 补回 `failurePauseThreshold`、`summarizationFallback`、`windowReset` 三个默认值 |
| `compaction-image-offload` 的「后续摘要失败是终态」 | 测试按 fork 语义适配 | 回退会再发起一次路由模型调用，脚本与调用次数断言随之更新；同时补一条回退成功的正向用例 |
| `typert` 工具目录签名、`verify-type-equiv` | 合并暴露的真实缺陷 | fork 新增的事件声明与 `approvalResources` 写成多行内联对象，`api-catalog` 取源文本、typert 分析器归一化空白，两路输出必然不一致。事件声明改成单行；内联对象类型提名为 `ToolApprovalResources`；重生成目录与文档块 |
| `client-ui-theme` 滚动条回载 | 合并暴露的真实缺陷 | fork 的 `btw` 对话框在输入面抬升层内滚动却未回载 `--dsh-scrollbar-thumb{,-hover}` 对，补回载 |
| `ui-workspace` 会话菜单 | 测试按 fork 语义适配 | 期望列表补 fork 的「永久删除会话」，分隔符数 3 改 4 |
| `release/families` 实验包清单 | fork 目录布局差异 | fork 把 `agent-plugins`、`arena`、`followup`、`speculation`、`step-summary`、`tool-search`、`webhook` 移出 `packages/experimental/`，并新增 `fork-notice`、`openapi-tools`；期望列表按实际成员重写 |
| `cua-helper/payload` | fork 删除 release 工作流 | 去掉对已删 `release-publish.yml`、`release.yml` 的断言，改为断言 fork 的 `macos-package.yml` 调用 `scripts/cua-helper/stage.ts` |
| `harness-dev-context` 运行上下文 | 测试按 fork 语义适配 | fork 的运行上下文投影只重述变化节；断言改为「首个重述快照带回检出说明，后续增量只带端口」 |
| `tool-executor-ptc`、`tool-goal`、`tool-web` 的类型非法用例 | 测试按 fork 语义适配 | fork 的 `repairArgs` 会把数字/布尔字符串修复成声明类型，故把用例值换成不可修复的值（`'pending'`、`'unbounded'`、`{ nested: true }`） |
| `gen-tool-catalog` | 测试按 fork 语义适配 | 期望清单补 fork 的 `memory_write` |
| `auto-review` | 合并暴露的缺失桩 | `approval` 桩补 `registerFullAccess`/`requestFullAccess`（`permission-presets` 在加载时注册完全访问执行器） |
| `a2a-host/kafka-detect` | 本机路径含非 ASCII | `URL.pathname` 保留百分号编码导致读不到 compose 文件，改用 `fileURLToPath` |
| `liveshare` 凭据地平线（2 项） | 硬编码日期过期 | 夹具日期改为相对当前时刻（过去 1 分钟 / 未来 30 天），不再随日历失效 |

## 验证

```bash
export LC_ALL=C
export NODE_OPTIONS=--max-old-space-size=8192

pnpm run typecheck          # 5 个门禁全过
pnpm run build:artifacts    # 8 个周末门禁全过
pnpm run build:check        # 产物面与源码面一致性
pnpm run test:docs          # 文档门禁（含 type-equiv、双语配对、持久化格式引用）
pnpm exec vitest run        # 全量：60691 通过、1 既定期望失败、274 跳过
pnpm exec tsx scripts/release/verify.ts --family dsh  # 416 个成员统一 0.2.2-rc.3，发布顺序可解析
```

全量测试的 1 项失败固定是 `client-ui-forge/tests/lens-panel.host.spec.ts` 的「reads the old side at HEAD…」：该用例单跑需 12 秒，默认 5 秒超时必然超时，与其他 git 重载用例一样属本机性能（`worktree`、`client-ui-forge` 在 `--testTimeout=30000` 下全绿，单跑该用例用 `--testTimeout=120000` 也通过）。本机不建议为它放宽仓库默认超时。

本机注意：

- `apps/desktop` 的 flock 探测依赖宿主 addon；`pnpm run build:native-system` 只产出宿主 libc 的 `flock`，landlock/musl 属完整打包构建。
- `gen-cli-help` 会校验 `dsh <cmd> --help` 的 stderr；本机 `all_proxy` 指向 SOCKS 时 CLI 会打印代理降级告警，需先清掉 `all_proxy`/`ALL_PROXY` 再跑。
- 全量测试约 6.5 分钟；受影响的优先单包复跑。

## 复发预防

- **判断方向先看年龄**：上游测试里的「当前代」硬编码与 fork 的写入器版本必然同步漂移，改测试时把「当前代 / 未来代」成对替换，别只改报错那一处。
- **生成物不手写**：任何源码格式或类型形状变化都要重跑对应 `gen-*`；`api-catalog.ts` 取源文本、typert 取归一化签名，两者只在不换行的声明形状下一致，因此事件声明与内联对象类型都要写成单行或提名。
- **fork 功能不得吞掉其他恢复层**：压缩摘要错误瀑布、图像卸载、参数修复各有归属，新增回退与修复时确认没有截走别层的控制流错误。
- **合并后补桩与目录清单**：新增服务的桩要跟着补（`approval.registerFullAccess` 一类）；fork 的包移动要同步 `families`、生成目录与客户端清单。
- **文档配对与引用**：重生成后跑 `verify-translation-pairing --write <配对文件>`，逐个确认中文侧与英文侧一致后再记录；持久化格式引用用 `verify-persistence-formats --write` 刷新；wiki 页面不写提交哈希（`verify-repository-references` 直接拒绝）。
- **测试夹具别写绝对时间与绝对路径**：凭据地平线这类用例改用相对当前时刻，路径用 `fileURLToPath`。
- **版本对齐是合并收尾的一部分**：合并只把上游包与工作区根带到新版本，fork 自研包必然落后；发布前必须用 `release:dsh` 显式版本对齐整族（显式版本会修复混合版本，相对版本会拒绝运行）。

## 涉及模块

- 会话格式：[会话格式代际](../concepts/session-format-generations.md)、[会话格式 v5 落地](session-format-v5-landing.md)
- 压缩：[compaction-basic 摘要回退](../../../packages/compaction/compaction-basic/README.md)，图像卸载见 `packages/compaction/compaction-image-offload`
- 工具面：[工具目录与参数修复](../../../docs/subsystems/tools.md)、`ToolApprovalResources`
- 目录生成、双语配对、持久化格式引用：本页「验证」与「复发预防」
- 合并暴露的 lint 红项与本机超时：[lint 红项清零与本机测试预算](lint-debt-clearance-and-local-test-budget.md)
- 合并之后的发版：[发布 dsh 0.2.2-rc.4](release-dsh-0.2.2-rc.4.md)
