/**
 * Proxy Service Module - Anthropic Messages Route
 * Implements /v1/messages route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { PassThrough } from 'stream'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'
import {
  ChatCompletionRequest,
  ChatMessage,
  ChatMessageContent,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolChoice,
} from '../types'

type AnthropicRole = 'user' | 'assistant'

interface AnthropicTextBlock {
  type: 'text'
  text: string
}

interface AnthropicImageBlock {
  type: 'image'
  source?: {
    type?: string
    media_type?: string
    data?: string
    url?: string
  }
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input?: Record<string, unknown>
}

interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<{ type?: string; text?: string }>
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

interface AnthropicMessage {
  role: AnthropicRole
  content: string | AnthropicContentBlock[]
}

interface AnthropicToolDefinition {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

interface AnthropicMessagesRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string | Array<{ type?: string; text?: string }>
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: AnthropicToolDefinition[]
  tool_choice?: {
    type?: 'auto' | 'any' | 'tool' | 'none'
    name?: string
  }
}

const router = new Router({ prefix: '/v1' })

function generateRequestId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function getClientIP(ctx: Context): string {
  return ctx.headers['x-real-ip'] as string ||
    ctx.headers['x-forwarded-for'] as string ||
    ctx.ip ||
    'unknown'
}

function safeParseJson(input: string | undefined): Record<string, unknown> {
  if (!input) {
    return {}
  }

  try {
    const parsed = JSON.parse(input)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (!Array.isArray(value)) {
    return ''
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return ''
      }
      const block = item as { type?: unknown; text?: unknown }
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function toOpenAIMessageContent(parts: ChatMessageContent[]): string | ChatMessageContent[] | null {
  if (parts.length === 0) {
    return null
  }

  const allText = parts.every((p) => p.type === 'text')
  if (allText) {
    return parts
      .map((p) => p.text || '')
      .filter(Boolean)
      .join('\n')
  }

  return parts
}

function convertAnthropicMessagesToOpenAI(
  messages: AnthropicMessage[],
  system?: string | Array<{ type?: string; text?: string }>
): ChatMessage[] {
  const output: ChatMessage[] = []

  if (typeof system === 'string' && system.trim()) {
    output.push({ role: 'system', content: system })
  } else if (Array.isArray(system)) {
    const text = system
      .map((block) => (block?.type === 'text' ? block.text || '' : ''))
      .filter(Boolean)
      .join('\n')
    if (text.trim()) {
      output.push({ role: 'system', content: text })
    }
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      output.push({
        role: msg.role,
        content: msg.content,
      })
      continue
    }

    const messageParts: ChatMessageContent[] = []
    const assistantToolCalls: ChatCompletionMessageToolCall[] = []
    const deferredToolMessages: ChatMessage[] = []

    for (const block of msg.content) {
      if (block.type === 'text') {
        messageParts.push({
          type: 'text',
          text: block.text || '',
        })
        continue
      }

      if (block.type === 'image' && block.source) {
        const sourceType = block.source.type
        if (sourceType === 'base64' && block.source.data) {
          const mediaType = block.source.media_type || 'image/jpeg'
          messageParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${mediaType};base64,${block.source.data}`,
            },
          })
        } else if (sourceType === 'url' && block.source.url) {
          messageParts.push({
            type: 'image_url',
            image_url: {
              url: block.source.url,
            },
          })
        }
        continue
      }

      if (msg.role === 'assistant' && block.type === 'tool_use') {
        assistantToolCalls.push({
          id: block.id || `call_${Date.now().toString(36)}`,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        })
        continue
      }

      if (msg.role === 'user' && block.type === 'tool_result') {
        deferredToolMessages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: extractTextFromUnknown(block.content),
        })
      }
    }

    const content = toOpenAIMessageContent(messageParts)

    if (msg.role === 'assistant') {
      if (assistantToolCalls.length > 0 || content !== null) {
        output.push({
          role: 'assistant',
          content,
          ...(assistantToolCalls.length > 0 ? { tool_calls: assistantToolCalls } : {}),
        })
      }
    } else {
      if (content !== null) {
        output.push({
          role: 'user',
          content,
        })
      }
      output.push(...deferredToolMessages)
    }
  }

  return output
}

function convertAnthropicToolsToOpenAI(tools?: AnthropicToolDefinition[]): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || {},
    },
  }))
}

function convertAnthropicToolChoiceToOpenAI(
  toolChoice?: AnthropicMessagesRequest['tool_choice']
): ChatCompletionToolChoice | undefined {
  if (!toolChoice?.type) {
    return undefined
  }

  if (toolChoice.type === 'auto') {
    return 'auto'
  }

  if (toolChoice.type === 'any') {
    return 'required'
  }

  if (toolChoice.type === 'none') {
    return 'none'
  }

  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      type: 'function',
      function: {
        name: toolChoice.name,
      },
    }
  }

  return undefined
}

function mapStopReason(finishReason: string | null | undefined): 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' {
  if (finishReason === 'length') {
    return 'max_tokens'
  }
  if (finishReason === 'tool_calls') {
    return 'tool_use'
  }
  if (finishReason === 'content_filter') {
    return 'stop_sequence'
  }
  return 'end_turn'
}

function mapOpenAIResponseToAnthropic(openaiResponse: any, fallbackModel: string): any {
  const choice = openaiResponse?.choices?.[0]
  const message = choice?.message
  const contentBlocks: any[] = []

  if (message?.content) {
    if (typeof message.content === 'string') {
      contentBlocks.push({
        type: 'text',
        text: message.content,
      })
    } else if (Array.isArray(message.content)) {
      const text = message.content
        .map((part: any) => (part?.type === 'text' ? part.text || '' : ''))
        .filter(Boolean)
        .join('\n')
      if (text) {
        contentBlocks.push({
          type: 'text',
          text,
        })
      }
    }
  }

  if (Array.isArray(message?.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      contentBlocks.push({
        type: 'tool_use',
        id: toolCall.id || `tool_${Date.now().toString(36)}`,
        name: toolCall.function?.name || 'unknown_tool',
        input: safeParseJson(toolCall.function?.arguments),
      })
    }
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({
      type: 'text',
      text: '',
    })
  }

  const usage = openaiResponse?.usage || {}
  const responseId = typeof openaiResponse?.id === 'string' && openaiResponse.id
    ? openaiResponse.id
    : generateRequestId()

  return {
    id: responseId.startsWith('msg_') ? responseId : `msg_${responseId}`,
    type: 'message',
    role: 'assistant',
    model: openaiResponse?.model || fallbackModel,
    content: contentBlocks,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  }
}

function createAnthropicStream(openAIStream: NodeJS.ReadableStream, model: string, messageId: string): NodeJS.ReadableStream {
  const output = new PassThrough()
  let buffer = ''
  let messageStarted = false
  let textBlockStarted = false
  let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' = 'end_turn'
  let outputTokens = 0

  const writeEvent = (event: string, payload: unknown): void => {
    output.write(`event: ${event}\n`)
    output.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  const ensureMessageStart = (): void => {
    if (messageStarted) {
      return
    }
    messageStarted = true
    writeEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    })
  }

  const ensureTextBlockStart = (): void => {
    ensureMessageStart()
    if (textBlockStarted) {
      return
    }
    textBlockStarted = true
    writeEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'text',
        text: '',
      },
    })
  }

  const flushDone = (): void => {
    ensureMessageStart()

    if (textBlockStarted) {
      writeEvent('content_block_stop', {
        type: 'content_block_stop',
        index: 0,
      })
    }

    writeEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: {
        output_tokens: outputTokens,
      },
    })

    writeEvent('message_stop', {
      type: 'message_stop',
    })

    output.end()
  }

  openAIStream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8')
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) {
        continue
      }

      const payload = trimmed.slice(5).trim()
      if (!payload) {
        continue
      }

      if (payload === '[DONE]') {
        flushDone()
        return
      }

      try {
        const parsed = JSON.parse(payload)
        const choice = parsed?.choices?.[0]
        const delta = choice?.delta

        if (delta?.content) {
          ensureTextBlockStart()
          writeEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: delta.content,
            },
          })
        }

        if (choice?.finish_reason) {
          stopReason = mapStopReason(choice.finish_reason)
        }

        if (typeof parsed?.usage?.completion_tokens === 'number') {
          outputTokens = parsed.usage.completion_tokens
        }
      } catch {
        // ignore malformed SSE payload from upstream
      }
    }
  })

  openAIStream.once('end', () => {
    if (!output.writableEnded) {
      flushDone()
    }
  })

  openAIStream.once('error', (error: Error) => {
    if (output.writableEnded) {
      return
    }
    writeEvent('error', {
      type: 'error',
      error: {
        type: 'api_error',
        message: error.message,
      },
    })
    output.end()
  })

  return output
}

router.post('/messages', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(ctx)

  let request: AnthropicMessagesRequest
  try {
    request = ctx.request.body as AnthropicMessagesRequest
  } catch {
    ctx.status = 400
    ctx.body = {
      error: {
        type: 'invalid_request_error',
        message: 'Invalid request body',
      },
    }
    return
  }

  if (!request?.model) {
    ctx.status = 400
    ctx.body = {
      error: {
        type: 'invalid_request_error',
        message: 'Missing required field: model',
      },
    }
    return
  }

  if (!Array.isArray(request?.messages) || request.messages.length === 0) {
    ctx.status = 400
    ctx.body = {
      error: {
        type: 'invalid_request_error',
        message: 'Missing required field: messages',
      },
    }
    return
  }

  const openAIRequest: ChatCompletionRequest = {
    model: request.model,
    messages: convertAnthropicMessagesToOpenAI(request.messages, request.system),
    temperature: request.temperature,
    top_p: request.top_p,
    stop: request.stop_sequences,
    max_tokens: request.max_tokens,
    stream: request.stream === true,
    tools: convertAnthropicToolsToOpenAI(request.tools),
    tool_choice: convertAnthropicToolChoiceToOpenAI(request.tool_choice),
    tool_format: 'native',
  }

  const config = storeManager.getConfig()
  const preferredProviderId = modelMapper.getPreferredProvider(openAIRequest.model)
  const preferredAccountId = modelMapper.getPreferredAccount(openAIRequest.model)

  const selection = loadBalancer.selectAccount(
    openAIRequest.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId
  )

  if (!selection) {
    ctx.status = 503
    ctx.body = {
      error: {
        type: 'service_unavailable_error',
        message: `No available account for model: ${openAIRequest.model}`,
      },
    }
    return
  }

  const { account, provider, actualModel } = selection

  proxyStatusManager.recordRequestStart(openAIRequest.model, provider.id, account.id)

  try {
    const result = await requestForwarder.forwardChatCompletion(
      openAIRequest,
      account,
      provider,
      actualModel,
      {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: openAIRequest.model,
        actualModel,
        startTime,
        isStream: openAIRequest.stream || false,
        clientIP,
      }
    )

    const latency = Date.now() - startTime

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)

      ctx.status = result.status || 500
      ctx.body = {
        error: {
          type: 'api_error',
          message: result.error || 'Request failed',
        },
      }
      return
    }

    proxyStatusManager.recordRequestSuccess(latency)
    loadBalancer.clearAccountFailure(account.id)

    storeManager.updateAccount(account.id, {
      lastUsed: Date.now(),
      requestCount: (account.requestCount || 0) + 1,
      todayUsed: (account.todayUsed || 0) + 1,
    })

    if (openAIRequest.stream && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')
      ctx.body = createAnthropicStream(result.stream, actualModel, requestId)
      return
    }

    ctx.set('Content-Type', 'application/json')
    ctx.body = mapOpenAIResponseToAnthropic(result.body || {}, actualModel)
  } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    ctx.status = 500
    ctx.body = {
      error: {
        type: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    }
  }
})

export default router
