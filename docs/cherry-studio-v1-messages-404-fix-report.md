# Cherry Studio `POST /v1/messages` 404 调查与修复报告

## 问题现象

- 访问 `POST /v1/messages` 返回：
  - `{ "error": { "message": "Route not found: POST /v1/messages" } }`
- Cherry Studio 使用的是 Anthropic Messages API 风格，请求入口应为 `/v1/messages`。

## 根因

现有代理仅注册了 OpenAI 风格入口：

- `POST /v1/chat/completions`
- `POST /v1/completions`

未注册 `/v1/messages`，因此直接命中全局 404 回退。

## 修复内容

新增 Anthropic 兼容路由 `POST /v1/messages`，并做双向格式转换（非重定向）：

1. 请求侧（Anthropic -> 内部 ChatCompletionRequest）
- `system` 合并为 OpenAI `system` 消息
- `messages` 内容块转换（`text`/`image`/`tool_use`/`tool_result`）
- `tools` 转 OpenAI `tools`
- `tool_choice` 转 OpenAI `tool_choice`
- `stop_sequences` 转 `stop`
- 设置 `tool_format: 'native'` 以保持工具调用兼容

2. 响应侧（OpenAI -> Anthropic Message）
- `choices[0].message.content` 转 `content` block
- `tool_calls` 转 `tool_use` block
- `finish_reason` 映射为 Anthropic `stop_reason`
- `usage.prompt_tokens/completion_tokens` 映射为 `input_tokens/output_tokens`

3. 流式响应兼容
- 将 OpenAI SSE chunk 转换为 Anthropic SSE 事件序列：
  - `message_start`
  - `content_block_start`
  - `content_block_delta`
  - `content_block_stop`
  - `message_delta`
  - `message_stop`

4. 路由注册与服务端端点声明
- 在 routes 索引中注册新路由
- 在根信息接口的 endpoints 列表中加入 `POST /v1/messages`

## 本地验证

### 命令 1：构建检查

```powershell
npm run build
```

结果摘要：
- 构建成功，无 TypeScript 构建错误。

### 命令 2：最小路由/请求体验证脚本

```powershell
node_modules\.bin\esbuild scripts/verify-anthropic-route.ts --bundle --platform=node --format=cjs --alias:electron=./scripts/mocks/electron.ts --outfile=scripts/verify-anthropic-route.cjs
$env:ELECTRON_OVERRIDE_DIST_PATH = 'D:\1work\chat2api\node_modules\electron\dist'
node .\scripts\verify-anthropic-route.cjs
```

结果摘要：
- 有效请求（包含 `model` + `messages`）返回 `503`（无可用账号），说明：
  - 路由存在
  - 请求体已被正确接收并进入业务流程（不再是 404）
- 无效请求（缺少 `messages`）返回 `400`：
  - `Missing required field: messages`
  - 说明 Anthropic 请求体验证逻辑生效

示例输出：

```json
{
  "validRequest": {
    "status": 503,
    "body": {
      "error": {
        "type": "service_unavailable_error",
        "message": "No available account for model: test-model"
      }
    }
  },
  "invalidRequest": {
    "status": 400,
    "body": {
      "error": {
        "type": "invalid_request_error",
        "message": "Missing required field: messages"
      }
    }
  }
}
```

