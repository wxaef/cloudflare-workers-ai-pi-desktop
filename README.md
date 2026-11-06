# Cloudflare Workers AI for PI-Desktop

通过 PI-Desktop 插件启动一个只监听 `127.0.0.1` 的 OpenAI Chat Completions 桥接服务，将请求转发到 Cloudflare Workers AI。插件不会修改 PI 的模型列表；安装后需要在 PI 的模型设置中添加一次 OpenAI 兼容提供商。

## 功能

- 插件加载时启动本机桥接，卸载/退出时关闭由本插件创建的服务。
- 插件面板保存 Cloudflare Account ID 和 API Token，并默认不回显 Token。
- 动态读取账户可用的 Text Generation 模型，并过滤 Cloudflare 明确要求 Paid 账单方式的模型。
- 支持手动填写模型 ID；手动 ID 不经过目录过滤，仍可能受套餐限制。
- 提供 OpenAI 格式的 `GET /v1/models` 与 `POST /v1/chat/completions`。
- 原样转发 Chat Completions JSON，支持流式响应与工具调用转发；所选模型实际支持情况取决于 Cloudflare。
- 为本机 API 生成独立 Key；上游 Cloudflare Token 不会发送到 PI 模型客户端。
- 推理请求固定转发至 `api.cloudflare.com`，拒绝 HTTP 重定向，服务仅绑定 `127.0.0.1`。

## 安装

在 PI-Desktop 的 Plugins 页面选择 **Load development plugin** 并指向本目录，或运行 `PluginPack` 生成可安装的 `.piplug` 文件后从插件页面安装。允许插件请求面板、后台服务、网络访问和剪贴板权限。

## 配置

1. 在 Cloudflare 控制台创建仅有必要 Workers AI 权限的 API Token，并准备 Account ID。模型目录查询需要 Workers AI Read 或 Write 权限；模型推理需要允许 Workers AI 推理的权限。
2. 打开插件面板，填写 Account ID 与 API Token，先点「测试并读取模型」，确认能查到模型，再保存。
3. 在 PI → 设置 → 模型中添加 OpenAI 兼容的 Chat Completions 提供商：
   - 提供商名称：`Cloudflare Workers AI`
   - API 类型：`openai-completions`
   - Base URL：`http://127.0.0.1:18766/v1`
   - API Key：从插件面板显示/复制本地 API Key
   - 模型：从目录选择或填写准确模型 ID（例如 `@cf/meta/llama-3.1-8b-instruct`，具体可用性以账户目录为准）
4. 在 PI 模型选择器里选择刚添加的提供商及模型。

插件会在数据目录保存 `cloudflare-workers-ai.json`，包含 Account ID、Cloudflare Token 和本地 API Key。Token 不会写入日志或发回面板，但该文件并未由本插件额外加密；请按本机账户文件权限保护。服务只监听回环地址，所有 `/v1/*` 请求都要求本地 API Key。模型目录查询不会发起推理；真实聊天会消耗 Cloudflare Workers AI 配额/费用。

## 许可证与安全边界

本插件源码采用 MIT 许可证，见 [LICENSE](LICENSE)。插件会在 PI 插件数据目录保存 Cloudflare Account ID、API Token 和本地 API Key；Cloudflare Token 不返回面板、不写日志，但配置文件不由插件加密。插件进程中的本机文件写入不由 PI 的文件权限网关代理，请只安装你信任的插件构建。

安装时需要批准 `net.fetch`（仅允许 `api.cloudflare.com`）、后台服务、插件面板和剪贴板权限。桥接仅监听 `127.0.0.1`，请求需要单独生成的本地 API Key。

## API 与边界

- Cloudflare API 基址固定为 `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`。
- 模型目录使用 `GET /accounts/{account_id}/ai/models/search?task=Text%20Generation&hide_experimental=true`。
- Free 过滤名单来自 [Cloudflare Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) 当前列出的 Paid-only 模型；Free 计划仍受每日 10,000 Neurons 免费额度限制。
- Cloudflare 目录记录的 UUID `id` 会映射为模型 `name`；若 PI 仍发送旧 UUID，桥接会尝试用当前目录映射后转发。
- 本机默认端口为 `18766`。若端口已被占用，插件不会接管或停止现有服务，面板会显示启动错误。
- Cloudflare 官方文档指出大多数文本生成模型支持 OpenAI Chat Completions；模型目录中的文本生成任务并不保证每个模型都支持流式或工具调用。
- 当前不代理 embeddings、音频、图像生成或 Responses API。

## 开发与验证

```powershell
node --test .\tests\bridge.test.cjs
```

再使用 PI-Desktop 的 `PluginCheck` 与 `PluginPack` 校验 manifest、插件内容和安装包。真实聊天测试需要在本机面板填写 Cloudflare 凭据；本项目测试不会发送真实 Cloudflare 推理请求。
