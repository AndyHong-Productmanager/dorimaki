// Deterministic opencode-style ids derived from omo records, so live events
// and history read back through `get_messages` agree on message/part ids.

import crypto from 'node:crypto'

export function newSessionId(): string {
  return `ses_${crypto.randomBytes(16).toString('hex').slice(0, 26)}`
}

export function isDorimakiSessionId(id: string): boolean {
  return /^ses_[A-Za-z0-9]+$/.test(id)
}

export function userMessageId(timestamp: number): string {
  return `msg_u${timestamp}`
}

export function assistantMessageId(timestamp: number): string {
  return `msg_a${timestamp}`
}

export function contentPartId(messageId: string, contentIndex: number): string {
  return `prt_${messageId.slice(4)}_${contentIndex}`
}

export function stepPartId(messageId: string, kind: 'start' | 'finish'): string {
  return `prt_${messageId.slice(4)}_${kind}`
}

export function toolPartId(toolCallId: string): string {
  return `prt_tool_${toolCallId.replace(/[^A-Za-z0-9]/g, '_').slice(0, 120)}`
}

// omo's question tools are rendered by the Discord question UI, like
// opencode's `question` tool, so they are reported under that name.
const QUESTION_TOOLS = new Set(['ask_user_question', 'request_user_input', 'question'])

export function toOpencodeToolName(toolName: string | undefined): string {
  if (!toolName) return 'unknown'
  return QUESTION_TOOLS.has(toolName) ? 'question' : toolName
}
