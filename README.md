# ST-GCP-Billing：SillyTavern Vertex AI 精确计费插件

直接读取 Vertex AI 每次响应里的官方 `usageMetadata` 进行计费，不使用任何 Tokenizer 估算。

## 组成

| 目录 | 安装位置 | 作用 |
| --- | --- | --- |
| `server/` | `SillyTavern/plugins/vertex-billing/` | 服务端插件：截获 Vertex 原始响应，记账、算价、提供 API |
| `extension/` | `SillyTavern/public/scripts/extensions/third-party/vertex-billing/` | 前端扩展：汇总面板、定价表、清零、每次请求弹窗 |

两个目录都已被 SillyTavern 的 `.gitignore` 忽略，不会影响 `git pull`。

## 安装

```bash
./install.sh /opt/sillytavern-player/SillyTavern
# 在 SillyTavern/config.yaml 中设置 enableServerPlugins: true，然后重启酒馆
```

账本和定价保存在 `plugins/vertex-billing/data/`（`ledger.jsonl`、`settings.json`），重新安装不会覆盖。

## 原理

酒馆后端用 node-fetch 请求 Vertex。非流式时，后端只把文本转发给浏览器，`usageMetadata` 被丢弃，前端无法拿到。
服务端插件在启动时给 node-fetch 的 `Response` 原型加了只读旁路：

- 非流式：`response.text()/json()` 读完后，如果地址是 Vertex `:generateContent`，解析出 `usageMetadata` 记账；
- 流式：酒馆读取 `response.body` 时，如果地址是 Vertex `:streamGenerateContent`，在同一个流上额外监听数据，取最后一个 `usageMetadata`。

返回给酒馆的数据原样不变。图片描述等其它走 Vertex `generateContent` 的调用同样会被记录。

## 计费规则

- 缓存部分（`cachedContentTokenCount`）按缓存价，其余输入按输入价；`toolUsePromptTokenCount` 按输入价；
- 思考 Token（`thoughtsTokenCount`）按输出价；
- 提示词超过"长上下文阈值"时，整次请求的输入/输出/缓存都改用"长·"价格；
- 按 `promptTokensDetails` 等的模态区分音频输入、图片输出价格（未填写则按普通价）。

## 测试

```bash
node --test tests/pricing.test.mjs                 # 计价单元测试
node tests/mock-vertex.mjs &                       # 模拟 Vertex（端口 9444）
# 用独立 config（enableServerPlugins: true）启动一个测试酒馆，并在插件 data/settings.json 的 hostPattern 中加入 ^127\.0\.0\.1$
ST_URL=http://127.0.0.1:9333 node tests/e2e.mjs    # 端到端测试
```

