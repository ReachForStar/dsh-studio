# 论文阅读器翻译跟随会话模型

- [x] 客户端：PaperReaderTab 从会话 `modelSelection` 投影取当前模型路由，经 PaperView/PdfViewer 随翻译请求发送
- [x] 宿主：`/paper-reader/translate` 校验可选路由并按该路由解析候选；无路由时用部署默认模型（agentDefaultModel），再退回目录顺序
- [x] 补依赖与工程引用（client：dsh-agent、ui-session；host：dsh-agent-default-model）
- [x] 更新单元测试（客户端路由透传、宿主路由优先级与校验）
- [x] 验证：包内单测、typecheck、构建产物与相关门禁
- [x] 更新 README（中英）与 wiki 条目
- [ ] 提交
