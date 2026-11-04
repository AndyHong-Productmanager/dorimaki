// Converts omo (senpi) AgentMessages into opencode SDK message/part shapes.
// Used both by the live event translator and for history reads
// (`session.messages` -> `get_messages`).

import {
  assistantMessageId,
  contentPartId,
  stepPartId,
  toOpencodeToolName,
  toolPartId,
  userMessageId,
} from './ids.js'

type Json = Record<string, any>

export type OpencodeMessageWithParts = { info: Json; parts: Json[] }

const FINISH_BY_STOP_REASON: Record<string, string> = {
  stop: 'stop',
  toolUse: 'tool-calls',
  length: 'length',
  error: 'error',
  aborted: 'aborted',
}

export function finishFromStopReason(stopReason: string | undefined): string | undefined {
  if (!stopReason || stopReason === 'pending') return undefined
  return FINISH_BY_STOP_REASON[stopReason] ?? 'unknown'
}

export function errorFromAssistant(message: Json): Json | undefined {
  if (message.stopReason === 'aborted') {
    return { name: 'MessageAbortedError', data: { message: message.errorMessage || 'Aborted' } }
  }
  if (message.stopReason === 'error') {
    return {
      name: 'APIError',
      data: {
        message: message.errorMessage || 'The model provider returned an error',
        providerID: message.provider,
      },
    }
  }
  return undefined
}

export function tokensFromUsage(usage: Json | undefined): Json {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    reasoning: 0,
    cache: { read: usage?.cacheRead ?? 0, write: usage?.cacheWrite ?? 0 },
  }
}

export function buildAssistantInfo({
  sessionID,
  message,
  parentID,
  cwd,
  completedAt,
}: {
  sessionID: string
  message: Json
  parentID: string | undefined
  cwd: string
  completedAt?: number
}): Json {
  const created = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
  const info: Json = {
    id: assistantMessageId(created),
    sessionID,
    role: 'assistant',
    parentID: parentID ?? '',
    time: completedAt ? { created, completed: completedAt } : { created },
    modelID: message.model ?? '',
    providerID: message.provider ?? '',
    mode: 'build',
    agent: 'build',
    path: { cwd, root: cwd },
    cost: message.usage?.cost?.total ?? 0,
    tokens: tokensFromUsage(message.usage),
  }
  if (completedAt) {
    const finish = finishFromStopReason(message.stopReason)
    if (finish) info.finish = finish
    const error = errorFromAssistant(message)
    if (error) info.error = error
  }
  return info
}

export function buildUserInfo({ sessionID, message }: { sessionID: string; message: Json }): Json {
  const created = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
  return {
    id: userMessageId(created),
    sessionID,
    role: 'user',
    time: { created },
    agent: 'build',
  }
}

export function userText(message: Json): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((block: Json) => block?.type === 'text')
    .map((block: Json) => block.text ?? '')
    .join('\n')
}

export function toolResultText(result: Json | undefined): string {
  const content = result?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: Json) => block?.type === 'text')
    .map((block: Json) => block.text ?? '')
    .join('\n')
}

export function toolTitle(args: Json | undefined): string | undefined {
  const title = args?.summary ?? args?.description ?? args?.title
  return typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : undefined
}

export function buildToolPart({
  sessionID,
  messageID,
  toolCallId,
  toolName,
  state,
}: {
  sessionID: string
  messageID: string
  toolCallId: string
  toolName: string | undefined
  state: Json
}): Json {
  return {
    id: toolPartId(toolCallId),
    sessionID,
    messageID,
    type: 'tool',
    callID: toolCallId,
    tool: toOpencodeToolName(toolName),
    state,
  }
}

export function completedToolState({
  args,
  result,
  start,
  end,
}: {
  args: Json
  result: Json | undefined
  start: number
  end: number
}): Json {
  const output = toolResultText(result)
  if (result?.isError) {
    return { status: 'error', input: args, error: output.slice(0, 2000) || 'error', time: { start, end } }
  }
  return {
    status: 'completed',
    input: args,
    output,
    title: toolTitle(args) ?? '',
    metadata: {},
    time: { start, end },
  }
}

/** History conversion for `session.messages`. */
export function agentMessagesToOpencode({
  sessionID,
  messages,
  cwd,
}: {
  sessionID: string
  messages: Json[]
  cwd: string
}): OpencodeMessageWithParts[] {
  const toolResults = new Map<string, Json>()
  for (const message of messages) {
    if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
      toolResults.set(message.toolCallId, message)
    }
  }

  const result: OpencodeMessageWithParts[] = []
  let parentID: string | undefined
  for (const message of messages) {
    if (message?.role === 'user') {
      const info = buildUserInfo({ sessionID, message })
      parentID = info.id
      result.push({
        info,
        parts: [{ id: contentPartId(info.id, 0), sessionID, messageID: info.id, type: 'text', text: userText(message) }],
      })
      continue
    }
    if (message?.role !== 'assistant') continue

    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
    const info = buildAssistantInfo({ sessionID, message, parentID, cwd, completedAt: timestamp })
    const parts: Json[] = [{ id: stepPartId(info.id, 'start'), sessionID, messageID: info.id, type: 'step-start' }]
    const blocks: Json[] = Array.isArray(message.content) ? message.content : []
    blocks.forEach((block, index) => {
      const base = { id: contentPartId(info.id, index), sessionID, messageID: info.id }
      if (block?.type === 'text') {
        parts.push({ ...base, type: 'text', text: block.text ?? '', time: { start: timestamp, end: timestamp } })
      } else if (block?.type === 'thinking') {
        parts.push({ ...base, type: 'reasoning', text: block.thinking ?? '', time: { start: timestamp, end: timestamp } })
      } else if (block?.type === 'toolCall' && typeof block.id === 'string') {
        const toolResult = toolResults.get(block.id)
        const end = typeof toolResult?.timestamp === 'number' ? toolResult.timestamp : timestamp
        parts.push(buildToolPart({
          sessionID,
          messageID: info.id,
          toolCallId: block.id,
          toolName: block.name,
          state: completedToolState({ args: block.arguments ?? {}, result: toolResult, start: timestamp, end }),
        }))
      }
    })
    parts.push({
      id: stepPartId(info.id, 'finish'),
      sessionID,
      messageID: info.id,
      type: 'step-finish',
      reason: info.finish ?? 'stop',
      cost: info.cost,
      tokens: info.tokens,
    })
    result.push({ info, parts })
  }
  return result
}

