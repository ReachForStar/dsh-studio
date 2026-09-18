# Agent Note: 从右侧栏文件树删除工作区文件

Status: implemented

[English](2026-09-18-workspace-file-deletion.md) | 中文

## 问题

右侧栏「工作区文件」树能浏览工作区，却什么都删不掉：`ctx.fs` 没有删除原语，`workspaceFiles` 没有删除端点，树画出的行除了打开之外没有任何动作。fork 曾经有过的唯一删除入口在自己的 `conversation.view` 文件标签页（`ui-polish` 的 `MutationDiffPanel`），而它在上一提交中因与本树重复而被移除——于是删除一个条目意味着离开浏览器去用终端或 `git rm`。

删除也是唯一**不能**按已解析目标（target）寻址的文件系统变更。`resolve()` 会跟随末段符号链接，因此 target 命名的是路径所指向的对象；经它删除会删掉链接的目标而不是链接本身。接缝上现有的变更操作（`writeText`、`writeBytes`、`editText`）全都接收 target，所以这个原语必须刻意打破那个形状。

## 决策

`ctx.fs.remove(path, opts?, signal?, sandboxPolicy?)` 加入接缝，按**路径**寻址并采用 `lstat` 语义：符号链接按链接本身删除，目录仅在 `recursive` 下连同内容删除，未带该标志的非空目录以新增错误码 `FS_NOT_EMPTY` 失败，结果回报该条目原本是什么（`file` | `directory` | `symlink` | `other`）。它不带版本守卫：删除以路径陈述，而不是从内容推导，所以调用方看过后又被改动的文件仍是它命名的那个文件。

每个 provider 都要实现它，因为接缝是抽象的、而部署各不相同：`fs-local` 经 `fsio.ts` 的 `removePath` 删除，`fs-sandbox` 按单次调用策略围栏，`fs-ssh` 发送新的 `fs.remove` helper 操作，fork 的 `fs-sftp` 经 SFTP 表面删除。

`fs-sandbox` 围栏的是**父目录**的规范化路径，而不是条目本身：条目可能正是符号链接，先解析它就会围栏（并随后删除）错误的路径。符号链接祖先仍会 realpath 进那次检查，而 `rm` 绝不会跟随被删树内部的链接，因此该围栏覆盖了它存在的那类逃逸。

`workspaceFiles.delete(scope, path, { recursive }, signal)` 是浏览器调用的 Remote 端点：以 `lstat` 检查条目、在条目**父目录**上证明包含性、委托给 `ctx.fs.remove`，并把后端的 `FS_NOT_EMPTY` 拒绝映射为线上词汇 `workspace-file/not-empty`。它叫 `delete` 而不是 `remove`，因为客户端命名空间服务自己占用了 `remove` 作为挂载生命周期方法，并拒绝遮蔽它的 Remote 方法（`client api: method "workspaceFiles/remove" conflicts with its namespace service`），这会让整个客户端插件在启动时失败。

文件树因此获得每行的删除控件与确认弹窗：弹窗点名该条目，对目录说明其内容一并删除，只有确认后才调用端点。Host 应答之前树上什么都不变；成功后被删行与其子树（已缓存的层与展开状态）一起消失并重读父层，失败则弹窗保持打开并显示映射后的原因。

## 备选方案

**软删除进回收站目录。** 设计被移除的面板时否决过一次，这里再次否决：工作区里的 `.trash` 会污染目录树、模型视野与 `git status`，而远端 SFTP 工作区也没有可依托的平台回收站。删除是永久的，并且确认文案如实说明。

**经 `/git/*` 宿主路由做删除**，即被移除面板的做法。否决：那些路由只存在于 Web 宿主组合中，并用 `node:fs` 解析路径，因此无法服务 `ctx.fs` 是远端 provider 的工作区——而正是这类部署才是 fork 新加的。接缝是唯一能触达所有 provider 的落点。

**像其他变更一样按 target 寻址删除。** 否决：已解析目标无法命名符号链接，链接（以及悬空链接）最好情况是删不掉，最坏情况是危险。

**只在本地 provider 实现删除，其他地方拒绝。** 否决：`FileSystem.remove` 是抽象方法，每个后端都必须作答；确实无法删除的纯文本或远端后端应当明说，而不是继承本地行为。`writeBytes` 是“基类默认拒绝”的先例，而删除并不存在那种“通道载不动”的情形。

**把客户端命名空间服务的 `remove` 生命周期方法改名以腾出名字。** 考虑后否决：该冲突位于所有命名空间共享的上游客户端运行时，为一个方法名去改它意味着同上游分道扬镳。`delete` 在线上不花任何代价，且与 UI 早已使用的词汇一致。

## 后果

删除是永久的：没有回收站、不可撤销，删除目录会连同其内容一起删掉。这一点写在确认文案、包 README 与本记录里。

fork 现在会改动一个上游浏览器包（`ui-sidebar-files`），不再只是新增包，因此上游合并该包时需要把删除动作一并带过去。替代方案——让 fork 再拥有一个文件界面——正是本树所要取代的重复。

面向模型的行为没有变化：没有任何工具暴露删除，因此不会进入模型请求，也没有新增会话事件。

## 测试

- 接缝与 provider：`fs-local` 删除文件、链接（保留其目标）、空目录与目录树，未带 `recursive` 时拒绝非空目录，并如实报告缺失与中止；`fs-sandbox` 在 `read-only` 下拒绝，在 `workspace-write` 下保持包含性（包括经离开工作区的链接），可删除链接本身，并把相对路径解析到 `opts.cwd` 与配置基准。
- 线上：`fs-ssh` 转发基准目录、recursive 标志与策略并保留 helper 的错误码；SSH helper 以协商到的工作区服务 `fs.remove`；`fs-sftp` 经真实进程内 SFTP 服务端删除、未带 `recursive` 时拒绝非空目录，并在可写根之外围栏。
- Remote 端点：`workspaceFiles.delete` 删除文件、空目录与目录树，按链接删除链接，拒绝工作区根与工作区外的路径（含经离开工作区的链接），映射 `FS_NOT_EMPTY`，并把其他后端拒绝原样透出。
- UI：确认之前树不发任何请求；只有目录才带 `recursive`；成功后行与子树一起消失并重读父层；失败时弹窗保持打开并显示映射后的原因；两个控件都能在不发请求的前提下关闭弹窗。
- 手工：`dsh web` → 右侧栏 → 工作区文件 → `tmp/del-demo`：删除 `doomed.txt` 后 `keep.txt` 保留、磁盘上该文件消失；删除 `sub`（内含 `nested.txt` 的目录）后两者都消失。
