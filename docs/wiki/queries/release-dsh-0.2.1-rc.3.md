---
title: 发布 dsh 0.2.1-rc.3（含四平台桌面安装包）
type: query
tags: [release, 发布, tag, 桌面安装包, 持久化, fork]
created: 2026-10-27
updated: 2026-10-27
sources: []
status: active
---

# 发布 dsh 0.2.1-rc.3（含四平台桌面安装包）

## 问题

fork 上已发布的 Release 只有 npm tarball 一个资产，没有各系统桌面安装包。需要发布 0.2.1-rc.3，让 `Release Desktop` 工作流为其附上 Linux deb/AppImage、Windows exe、macOS arm64/x64 dmg。

## 流程（按序，一步失败就停）

```bash
pnpm exec tsx scripts/release/verify.ts --family dsh   # 家族版本与发布顺序
pnpm run build:official                                  # 官方剖面构建，写构建记录
pnpm exec tsx scripts/release/pack.ts --family dsh --out dist/npm
git add -u packages && git commit -m "对齐 fork 自研包版本到 <版本>"   # 版本已在上一步前对齐
git push me master
git tag -f dsh-v<版本> <发布提交>
gh release create dsh-v<版本> -R <repo> --title ... --notes-file ... --prerelease \
  dist/dsh-<版本>-npm.tar.gz.zip
```

`gh release create` 不带 `--target`：远端 master 的 HEAD 就是发布提交，gh 据此创建 tag；带 `--target <sha>` 会被 API 判为 `Release.target_commitish is invalid`（422）。

## 根因与踩坑

### 家族版本未对齐

`release/verify` 首轮失败：`packages/xingchen/xingchen: 0.2.1-rc.2`。合并上游后 fork 的 18 个公开包停在上一版本，需全部对齐到家族版本（与 rc.2 发布时的同类情形）。**对齐全部完成后再跑 verify，再进入构建**——`build:official` 会把当前 HEAD 的 commit hash 写进构建记录，任何后续提交都会让记录失效。

### 同名 tag 指向上游

本地 `dsh-v0.2.1-rc.3` 原先由 fetch 指向上游提交（上游有同名 tag）。发布时用 `git tag -f` 把它移回 fork 发布提交；本地移动不涉及强推禁令，远端由 `gh release create` 新建。

### 手打路径无法命中（显示层掩码）

某 fork 包（`packages/core/` 下的 pi 后端包）在本会话中被反复判定「不存在」：`test -d`、`stat`、`fs.existsSync`、`git add <手打路径>` 全部失败，而 `ls <父目录>`、`git status` 又列出它。

根因不在文件系统：**该目录名的显示被掩码**，我按显示文本手打的路径与真实字节不一致。诊断方法是打印真实字节：

```js
Buffer.from(name, 'utf8').toString('hex')
```

该目录的 hex 解出来与其渲染文本不同，据此定位。教训与做法：

- 当 `ls`/`git status` 列出某路径而手打该路径 lookup 失败时，先怀疑显示层改写，不要断言目录损坏或跑 `rm -rf`。
- 提交这类改动时避开手打路径，用 `git add -u <目录>`（按索引更新已跟踪文件）。
- 同理，`grep`/`includes()` 对这类名字会漏配，不能用它判断某路径是否存在。

### 桌面工作流双触发

`gh release create` 会同时创建 tag 与 Release，于是 `push: tags: dsh-v*` 与 `release: published` 各触发一次；两者的 `concurrency.group` 取值不同（一个用 `github.ref`，一个用 `github.event.release.tag_name`），因此**并行跑两批构建**而非排队。两批都上传同名资产，`gh release upload --clobber` 后到者覆盖前到者，结果正确但浪费一倍构建时间。

## 签名与验证

### 已具备：Sigstore 无密钥签名（不需购买证书）

`.github/workflows/release-desktop.yml` 在构建后为每个安装包生成 `SHA256SUMS-<target>` 并调用 `actions/attest-build-provenance@v4.2.2`：工作流用自身的 OIDC 身份签名，证明记录写入仓库的证明存储，因此不购置证书、不保存签名私钥。作业权限需要 `id-token: write` 与 `attestations: write`（公共仓库免费）。

用户验证：

```bash
sha256sum -c SHA256SUMS-linux-x64            # 校验和
gh attestation verify <安装包> -R <owner>/<repo>   # 出处证明（需较新 gh）
```

### 尚未具备：平台原生签名

| 平台 | 当前状态 | 缺口 |
| --- | --- | --- |
| macOS | 应用已 **ad-hoc 签名**（`electron-builder-config.mjs` 中 `identity: unsigned ? '-' : ...`），DMG 容器不签名、不做公证 | 无 Developer ID，Gatekeeper 会拦截；用户需右键→打开 |
| Windows | 完全未签名 | 无代码签名证书 |
| Linux | 完全未签名 | 无 GPG 密钥（可选） |

### 需要申请的材料

**macOS**：Apple Developer Program 会员（年费）→ 取得 Developer ID Application 证书（导出为 `.p12`）与公证凭据。对应变量：

- `CSC_LINK`（p12 路径或 base64）、`CSC_KEY_PASSWORD`
- `DSH_DESKTOP_MACOS_SIGNING_IDENTITY`、`DSH_DESKTOP_MACOS_TEAM_ID`
- 公证三选一：`APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`；或 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`；或 `APPLE_KEYCHAIN_PROFILE`

**Windows**：EV 代码签名证书（含 SafeNet 硬件令牌）。对应变量：`DSH_DESKTOP_WINDOWS_CER_FILE`、`DSH_DESKTOP_WINDOWS_SIGNTOOL`、`DSH_DESKTOP_WINDOWS_KEY_CONTAINER`、`DSH_DESKTOP_WINDOWS_TOKEN_PIN`。仓库现有签名流程只支持 SafeNet 密钥容器（`windows-sign.mjs` 的 `resolveTokenIdentity` 强制要求 `KEY_CONTAINER` 与 `TOKEN_PIN`），因此**文件形式的 OV 证书无法直接用**；改用云签名服务（如 Azure Trusted Signing）需改代码。

**Linux**（可选）：自建 GPG 密钥，无需申请；可对 `.deb` 与校验和文件出分离签名并公布公钥。

### 签名构建的机器前置

签名构建不走 GitHub 托管运行器：

- Windows：`runs-on: dsh-win-package-trial`（自托管），凭据放在机器上 repo 外的 `packaging/secrets`，经 `apps/desktop/scripts/setup-windows-packaging.ps1` 初始化
- macOS：`runs-on: [self-hosted, macOS, ARM64, dsh-mac-package-trial]`

## 验证（发布流程）

- `pnpm exec tsx scripts/release/verify.ts --family dsh`：382 member(s)、0.2.1-rc.3、publish order resolved、0 个未排序的 peer 声明
- `pnpm run build:official`：10 门通过，记录 688 个客户端产物与 4 个公开值
- `pack`：382 个 tarball 落在 `dist/npm`，zip 后约 30MB
- Release `dsh-v0.2.1-rc.3` 已创建（prerelease），npm zip 已作为资产上传
- `Release Desktop` 工作流已触发（tag 与 release 两个事件各一次）

## 涉及模块

- [fork 发布 rc.2 的流程与门禁踩坑](fork-release-dsh-0.2.1-rc.2.md)：本流程的前一次记录（家族版本、`workspace:*` 协议、构建记录绑定 HEAD）。
- [Linux 桌面 deb 安装包与 Release 工作流](desktop-deb-release.md)：桌面工作流的四目标与三触发设计。
- [持久化历史分叉与来源种类补记](persistence-history-fork-repair.md)：本批先修掉的持久化门禁缺口。

## 复发预防

- 发布前先跑 `verify --family dsh`；合并上游后 fork 自研包版本必然落后，先对齐再构建。
- `build:official` 之后不要再提交；若已提交，重走 build + pack。
- 提交时对名字可疑的路径用 `git add -u <目录>`，并用 `Buffer.from(name,'utf8').toString('hex')` 核对真实字节，不要依赖显示文本。
- `gh release create` 不带 `--target`，让 master HEAD 定位发布提交。