# 论文阅读器翻译模型可选（面板内选择器）

## 里程碑

- [x] 宿主新增 `GET /paper-reader/models`，返回 LLM 目录（provider/model/name）
- [x] 客户端 `paper-api` 增加 `listTranslateModels`
- [x] 阅读页头部加「翻译模型」选择器：默认跟随会话模型，可固定为某个 provider/model，选择存 localStorage
  - 目录不再提供该组合或读取失败时回退会话路由。
- [x] 8 语言文案与中英 README
- [x] 测试：宿主 models 路由、客户端 api、页面选择器与路由透传
  - 另含陈旧本地值回退用例；包内 209 项通过。
- [x] 验证：包内测试、typecheck、build:check、lint、test:docs
  - 全量测试中两个 git 夹具用例在满负载下超时，单独复跑 34 项全绿（既有负载敏感项）。
- [x] wiki 更新（entity 页、query 页、index、log），提交推送
- [x] tmp 清理
