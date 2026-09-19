---
title: LaTeX 面板（ui-polish 的 /latex 路由与 Overleaf 式编辑流程）
type: entity
tags: [latex, xelatex, ui-polish, 面板, 路由, 编译]
created: 2026-09-19
updated: 2026-09-19
sources: []
status: active
---

# LaTeX 面板（ui-polish 的 /latex 路由与 Overleaf 式编辑流程）

## 职责

`@reachforstar/dsh-client-ui-polish` 在会话视图（`conversation.view`）注册 `latex` 标签页，基于**本机 TeX 发行版**提供 Overleaf 式流程：项目发现、文件树、`.tex` 就地编辑、xelatex 编译（ctex/xeCJK 中英文）、bibtex、PDF 实时预览、项目字体安装、`tlmgr` 包安装、构建产物清理、LLM 写作助手。宿主半边是 `src/latex-service.ts`，注册在 `/latex` 前缀路由上（`src/index.ts`）。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `src/latex-service.ts` | host 半边：项目发现、文件读写、编译、字体、AI 写作、路由分发 |
| `src/client/LatexPanel.tsx` | 标签页 UI：工具栏、文件树、编辑器、PDF 预览、字体弹窗、AI 弹窗 |
| `src/client/latex-client.ts` | `/latex/*` 的类型化 fetch 封装 |
| `src/client/LatexPanel.module.css` | 面板样式 |
| `src/llm-route.ts` | 与 Git 面板共用的 provider/model 路由（`listLlmModels` / `resolveLlmRoute`） |
| `tests/latex-service.host.spec.ts` | 路由、路径校验、编译（本机有 xelatex 时）、字体、模型目录 |

## `/latex` 路由

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/latex/projects` | POST `{cwd}` | 深度 ≤3 且直接含 `.tex` 的目录（跳过 `node_modules`/`.git` 等），上限 100 |
| `/latex/list` | POST `{cwd, dir}` | 项目文件树（深度 ≤3，上限 500 项） |
| `/latex/read` | POST `{cwd, dir, path}` | UTF-8 内容（上限 2 MiB） |
| `/latex/write` | POST `{cwd, dir, path, content}` | 新建或覆盖文件；**content 允许为空串**（新建空文件） |
| `/latex/compile` | POST `{cwd, dir, main}` | 编译并缓存 PDF；失败返回日志摘录 |
| `/latex/pdf` | GET `?cwd&dir&main` | 缓存的 PDF 字节 |
| `/latex/clean` | POST `{cwd, dir}` | 删除项目内构建产物（`*.aux`/`*.log`/…） |
| `/latex/fonts` | POST `{cwd, dir, op}` | `op=list` 项目字体与包状态；`op=install` 写入 `fonts/`；`op=install-package` 走 `tlmgr install` |
| `/latex/ai` | POST `{cwd, dir, path, selection?, instruction, model?}` | LLM 写作助手 |
| `/latex/models` | GET | 写作助手可路由的 provider/model 目录 |

`dir` 是**工作区相对**的项目目录（`.` 为工作区根），`path` 是**项目目录相对**路径——两者基准不同，客户端按此传参（`latex-client.ts` 的 `read`/`write` 都带 `dir`）。

## 编译链路

1. `mirrorProject`：把项目内可编译扩展名（`tex`/`bib`/`sty`/`cls`/图片/字体…）复制到 `mkdtemp` 临时目录；源项目保持干净。边界：最多 2000 个文件、总 512 MiB、单文件 64 MiB，跳过 `node_modules`/`dist`/`build`/`out`/`target`/`coverage`/版本控制目录；**目录符号链接按目录处理**（跟随链接）；被跳过的项目相对路径会被记录（见下条）。
2. 首遍 xelatex（`-interaction=nonstopmode -halt-on-error`，超时 180s）；失败则读 `.log` 并 `extractLogExcerpt`（首个 `!` 行前后共约 28 行）。
3. 若 `.aux` 含 `\bibdata{` 则跑 `bibtex`（引擎同样经 `findEngine` 解析，工作目录是**镜像内主文件所在目录**），失败时用 `extractBibtexExcerpt` 摘取诊断行（`Warning--`/`error message`/`Repeated entry`/`---line N of file` 等）及其上下文，而不是 `.blg` 尾部的函数调用直方图。
4. 再跑两遍 xelatex（交叉引用与目录）。
5. 成功则把 PDF 存入模块级缓存（最多 10 项，按时间淘汰），临时目录始终删除。
6. 同一项目+主文件同时只允许一次编译（`compiling` 集合互斥）。

引擎解析：`findEngine` 先试 PATH 中的名字，再探测 `C:/texlive/<年>/bin/windows/<name>{.exe,.bat}`，结果缓存在模块级变量；找不到时明确报“未找到”。

### 缺失引用的补齐与诊断

论文源码与实验图常分处不同目录树（本机实例：源码在 `E:/BDJ-Train/Paper/LaTeX`，图在 `E:/BDJ-Train/experiments/.../results`）。镜像只装项目内文件时编译会报 `File `x.png' not found`，因此编译前多一步 **`supplyWorkspaceGraphics`**：

1. 扫描镜像内全部 `.tex`，提取 `\includegraphics` 的引用与 `\graphicspath` 声明的搜索目录；
2. 对每个引用，按“主文件目录 + 每个 graphicspath”判定它是否已在镜像里；
3. 镜像里无处可寻的引用，在工作区内按**文件名**做有界广度优先搜索（≤4000 目录、深度 ≤8、跳过环境与缓存目录），命中则复制到镜像中引用所写的路径；
4. 补齐过的名字随编译结果返回，面板提示“已从工作区补充 N 个图片”。

失败日志仍会带上 `explainMissingReferences` 的结论，现在分四种：项目里不存在（提示先生成）、项目内存在但镜像漏了（提示命中上限）、**项目外但工作区内有**（给出工作区相对路径）、其它情况按原样展示。`missingReferences` 与 `explainMissingReferences` 均已导出供测试。

## 安全边界

- `resolveProjectDir` / `resolveProjectPath` 拒绝 `..`、前导斜杠、反斜杠，并要求解析结果落在基准目录内。
- 字体安装只接受 `.ttf/.otf/.otc/.ttc`、文件名无分隔符且 ≤128 字符、base64 解码后 ≤20 MiB。
- `tlmgr` 包名限制为 `^[A-Za-z0-9][A-Za-z0-9-]{0,63}$`。
- PDF 与字体大小上限分别是 20 MiB。

## LLM 写作助手

`/latex/ai` 取整份文件（截断 60000 字符）或选区，经 `src/llm-route.ts` 解析 provider/model 后流式生成，返回纯 LaTeX 文本。客户端 AI 弹窗提供模型下拉（`/latex/models`），选择保存在 `localStorage` 的 `dsh-latex-ai-model`；不选则“默认模型”=第一个提供模型的 provider。**默认 provider 没有可用凭证时会静默返回空结果**（服务端报 `the model returned an empty result`），因此模型选择是必要的绕过入口。

## 踩坑

- **`read`/`write` 的路径基准**：早期实现只传 `path` 且按工作区根解析，而文件树给出的是项目相对路径，子目录项目一律 ENOENT。修复方式是让这两个路由也接收 `dir` 并按项目目录解析（与 `/latex/ai` 一致）。
- **空文件写入被拒**：`bodyString` 要求非空，导致“新建文件”必然失败；新增 `bodyText` 允许空串。
- **镜像跳过 `fonts/`**（2026-09-19 修）：`SKIP_DIRS` 曾包含 `fonts`，而 `COPY_EXTS` 又支持 `.ttf/.otf`——用 `\setCJKmainfont[Path=fonts/]` 的项目一编译就报找不到字体/图片。现在 `fonts/` 正常镜像。
- **bibtex 的两个假定**（2026-09-19 修）：一是直接用 `bibtex` 名字而不经 `findEngine`，TeX Live 不在 PATH 的机器上会直接 ENOENT；二是在镜像根而非主文件目录运行，主文件在子目录的项目必然报 `I found no \bibdata`。两者均已修正。
- **bibtex 失败日志只有直方图**（2026-09-19 修）：`.blg` 尾部是 built-in 函数调用计数（`change.case$ -- 0` 那一串），旧实现照搬尾部，看不到真正的错误行；现在按诊断行提取。
- **项目外的图片**（2026-09-19 修）：来自实验室输出的图常在项目目录之外，镜像器看不到。现在编译前会按 `\includegraphics` 与 `\graphicspath` 在工作区内补齐（见上），本机实测论文项目从 11 张补齐收敛到真实的 6 张、PDF 3.39 MB 编译成功。
- **镜像截断无提示**（2026-09-19 修）：旧实现的 300 文件上限在循环内直接 `return`，超出后剩余目录一个文件都不复制且无任何提示；单文件上限也只有 10 MiB。现已改为“文件数 + 总字节 + 单文件”三重边界，跳过项记录并在失败时输出。
- **改了客户端源码必须重建产物**（见 [fork Web 面板](fork-web-panels.md)）。

## 验证

- 单测：`tests/latex-service.host.spec.ts`（项目发现、文件树、读写与空文件、路径逃逸、clean、字体安装、模型目录、缺失引用诊断四例、工作区图片补齐、graphicspath 不重复补齐、AI 无 provider 快速失败、PDF 404、真实 xelatex 编译成功与失败两种）。
- 手工（2026-09-19，Windows + TeX Live 2026）：项目下拉 → 打开 `main.tex` → 编辑保存触发自动编译 → `/latex/pdf` 返回 24840 字节 PDF；新建 `notes/section.tex`（0 字节）；AI 写作选 `qwen-3.8-27B` 生成中文致谢写入编辑器；含 `figures/*.png` 与 `fonts/*.png` 的项目编译成功（`/latex/pdf` 2819 字节）；引用不存在图片的项目在日志末尾给出 `fig-keypoints.pdf is not in the project directory` 诊断。

## 关联页面

- 同包其他面板与 `/git` 路由：[fork Web 面板](fork-web-panels.md)
- 本次修复的缺陷清单：[Git/LaTeX 面板重写的缺陷与修复](../queries/ui-polish-git-latex-defects.md)
- 面板包契约：`packages/client/ui-polish/README.md`
