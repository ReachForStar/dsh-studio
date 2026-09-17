# Agent Note：在预览之处编辑 Word 与 PowerPoint 文档

Status: implemented

[English](2026-09-17-office-document-editing.md) | 中文

## 问题

预览的文本编辑器覆盖浏览器能当作文本持有的文件，与它一同加入的字节写入端点（`workspaceFiles.write`）也是文本。office 文档两者都不是：`.docx` 与 `.pptx` 是 XML 部件的压缩包，展示它需要解开压缩包，保存它需要把压缩包写回去。而 harness 里没有任何地方能向文件写二进制：文件系统 seam 只有 `writeText` 与 `editText`。

## 决策

文件系统 seam 新增 `writeBytes`，文档预览在其上新增两个渲染器。

`FileSystem.writeBytes` 是 Service Definition 上的一个**具体**方法，以 `FS_UNSUPPORTED_BINARY_WRITE` 拒绝，而不是第三个抽象变更方法。于是无法承载字节的后端（经由编码文本的通道抵达的文件系统）在调用点明说，既有提供方也无需为一项自己并不满足的义务而改动。`LocalFileSystem` 覆盖它（其原子写入器现在接受 `string | Uint8Array`），`SandboxedFileSystem` 用与 `writeText` 相同的逐调用策略围栏，`SshFileSystem` 继承拒绝，同时把错误码列入可透传名单。`workspaceFiles.writeBytes` 以 base64 承载字节，套用与 `write` 相同的守卫：工作区包含性、`maxFileBytes` 上限、编辑器读到的版本，并把拒绝映射为 `workspace-file/binary-unsupported`。

两个渲染器是同一形状配两个解析器。`parseDocx` 把 `word/document.xml` 读成段落文本，并返回一个闭包了已解包部件的 `rebuild`，因此编辑器只可能写回一份仍包含「读取器没看懂的一切」的文档；`parsePptx` 对每个 `ppt/slides/slideN.xml` 做同样的事，并按幻灯片编号排序。两个解析器都按**局部名**匹配 XML、忽略生产者选用的前缀；一次编辑保留既有的文本叶子——首个叶子取新文本，其余清空——因此 run 的格式与承载它的形状都留下来。zip 交给 `fflate`（本就是工作区依赖），这里不手写 DEFLATE。共享的 `OfficeBody` 外壳渲染任一形状，并且不持有保存状态：pane 已通过该 tab 的 store 跟踪写入，因此 `saving` 与 `saveFailure` 以 props 形式到达，失败行与文本编辑器用的是同一个 `failureLine`。

## 备选方案

**把 `writeBytes` 做成第三个抽象方法。** 每个提供方与每个测试替身都必须实现它，包括那些做不到的：编译器会向一个纯文本后端索取一句谎言。

**用文本端点写压缩包。** 文本字段里的 base64 并不是那个文件，一次编码偏差会产出损坏的文档，而且任何地方都不会报错。

**从解析出的模型重建整个 OOXML 部件。** 序列化一个模型意味着替你决定保留什么：样式、编号、域、批注与修订标记会从一份用户只想改个措辞的文档里静默消失。

**让每种格式各自实现编辑器组件。** 草稿、基线与保存状态逻辑各写两遍，office 的失败路径也会与文本编辑器渐行渐远。

## 后果

Word 段落与 PowerPoint 文本叶子可在预览中编辑，文档其余部分由构造保证保留；解析器不认识的格式（`.doc`、`.ppt`，以及缺少预期部件的压缩包）仍然报「无法打开」。二进制写入在 SSH 通道文件系统上不可用，它会明确拒绝而不是写坏文件。编辑停留在文本层：版式、表格、图片与新增形状不在范围内；两个渲染器都有解析器、外壳与注册用例覆盖。
