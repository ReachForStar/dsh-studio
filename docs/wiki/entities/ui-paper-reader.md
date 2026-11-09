---
title: 论文阅读器（ui-paper-reader）
type: entity
tags: [web, sidebar, pdf, 论文, 标注, fork]
created: 2026-11-09
updated: 2026-11-09
sources: []
status: active
---

# 论文阅读器（ui-paper-reader）

## 职责

`packages/client/ui-paper-reader`：右侧栏的论文阅读页。上传 PDF 后按原始排版渲染（页面、字体、图片全部由 PDF.js 绘制，不做文本重排），选中文字弹出悬浮菜单，提供高亮、添加笔记、在会话中提问三项操作。包名 `@reachforstar/dsh-client-ui-paper-reader`，版本 `0.2.2-alpha.2`。

## 关键文件与接口

| 文件 | 职责 |
| --- | --- |
| `src/route.ts` | 路由唯一来源：宿主注册 `PAPER_READER_ROUTE='/paper-reader'`，浏览器用去掉前导斜杠的 `PAPER_READER_CLIENT_ROUTE` 发起文档相对请求 |
| `src/index.ts` | 宿主 `apply`：把 `/paper-reader` 前缀挂到 `ctx.webServer`；`Config` 暴露 `directory`（默认 `dshHomePath('profiles','web','papers')`）与 `maxBytes`（默认 100 MiB） |
| `src/paper-service.ts` | 论文列表/上传/读取/删除与注释读写；上传在写盘前按 `maxBytes` 拒绝 |
| `src/types.ts` | 论文记录、摘要、注释与归一化矩形类型 |
| `src/client/definition.ts` | 右侧栏标签页定义（`kind: 'paperReader'`）与引导入口 |
| `src/client/PaperReader.tsx` | 页面骨架：上传、列表、打开/删除；提问动作经标准 `inputActions` 座位插入 |
| `src/client/PdfViewer.tsx` | PDF.js 页面渲染、文本层、高亮覆盖层、选中悬浮菜单与笔记列表 |
| `src/client/pdf/runtime.ts` | 每篇论文一个真实模块 Worker；启动失败直接报错，不回退主线程解析 |
| `src/client/pdf/assets.ts` | 构建期内联同版本 PDF.js 的 worker 源码与 cMap/标准字体/wasm 资源，运行期不发网络请求 |
| `src/client/pdf/render.ts`、`text.ts` | 页面位图渲染与可选中文本层 |
| `src/client/selection.ts` | 选区矩形按页面归一化（0–1 分数），保证缩放与窗口变化后高亮仍对齐 |
| `src/client/paper-api.ts` | 浏览器侧请求封装，错误带服务器状态 |

## 行为要点

- **提问不直接发送**：`askPrompt` 按界面语言生成，先经 `inputActions.captureInsertion()` 记录插入点，再 `insertText` 写入模板并用 `insertQuote` 追加选中原文；任一步失败返回 `false`，菜单显示不可用提示。
- **高亮几何**：注释保存归一化矩形，渲染时按当前页尺寸还原，避免缩放漂移。
- **样式约束**：悬浮菜单用 `ui-primitives` 的 `MenuSurface` 承载材质与阴影，本包只负责定位；圆角走 `--dsw-radius-*`，悬停规则包在 `@media (hover: hover)` 内，边框用 0.5px hairline。
- **文案**：8 语言 locale（en/zh/ja/de/es/fr/pt/ru），产品文案全部走 `t`。

## 接线

- `tsconfig.base.json` 路径别名、`tsconfig.client.json` 与 `tsconfig.host.json` 工程引用。
- `packages/bundle/web-app/cordis.patch.yml` 的 `ui-paper-reader` 行与 `packages/bundle/web-app/package.json` 依赖。
- `packages/client/README.md`/`.zh.md` 与 `README.i18n.yaml` 的包条目；`scripts/verify-package-readme-model-experience.ts` 登记。
- 宿主依赖：`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/schemastery`（`dependencies`）；`@deepseek-ai/cordis` 保持 `peerDependencies` 与 `devDependencies` 配对。

## 验证

- `tests/` 共 11 个 spec、131 项测试，`src/**` 逐文件覆盖率 100%。
- `scripts/build.ts --scope artifacts`（8 门）与 `--scope check`（2 门）通过。
- 已过门禁：`verify-client-packages`、`verify-export-jsdoc`、`verify-client-ui-i18n`、`verify-locale-metadata`、`verify-client-route-resolution`、`verify-package-readme-*`、`verify-translation-pairing`、`verify-product-use`、`verify-package-dependencies`（本包无违规项）。

## 待确认

- Web 快照通道（`DSH_SNAPSHOT=replay`）在本机基线上就红：`@reachforstar/dsh-client-ui-polish` 的 `client.rolldown-runtime.js` 在 assembled boot 测试脚手架里没有同步 chunk 供给，导致「每个 entry 必须激活」的 teardown 断言失败，连带多个 e2e 快照红。该红项与本包无关（去掉本包装载行后同样复现），修法见 [CJS 客户端包共享 runtime chunk](../queries/cjs-client-shared-runtime-chunk.md) 的测试通道缺口。

## 关联页面

- [fork Web 面板](fork-web-panels.md)：同属 fork 自研的右侧栏/面板族。
- [CJS 客户端包共享 runtime chunk](../queries/cjs-client-shared-runtime-chunk.md)：客户端包产物与同步 chunk 的装载约束。
- [fork 自研包的门禁红项清单](../queries/fork-gate-debt.md)：新 fork 包的接线与门禁归属。
