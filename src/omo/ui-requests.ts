// Maps omo extension UI dialogs onto dorimaki's opencode-shaped
// permission/question events, and Discord answers back onto
// `extension_ui_response` frames.
//
//   select "Permission required: ..." -> permission.asked
//   question                          -> question.asked
//   select / confirm                  -> question.asked (single question)
//   input / editor                    -> cancelled (no Discord UI for them)

type Json = Record<string, any>

type QuestionShape = {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiple?: boolean
}

export type PendingUiRequest = {
  requestID: string
  sessionID: string
  uiRequestId: string
  kind: 'permission' | 'question' | 'select' | 'confirm'
  options: string[]
  questionIds: string[]
  questions: QuestionShape[]
  tool: { messageID: string; callID: string } | undefined
}

export type UiRequestTranslation =
  | { kind: 'event'; pending: PendingUiRequest; event: { type: string; properties: Json } }
  | { kind: 'cancel'; reason: string }
  | { kind: 'toast'; event: { type: string; properties: Json } }
  | { kind: 'ignore' }

const PERMISSION_TITLE_PREFIX = 'Permission required:'
const CONFIRM_YES = 'Yes'
const CONFIRM_NO = 'No'

function parsePermissionTitle(title: string): { permission: string; patterns: string[] } {
  const lines = title.split('\n')
  const permission = (lines[0] ?? '').slice(PERMISSION_TITLE_PREFIX.length).trim() || 'unknown'
  const patterns: string[] = []
  const patternsIndex = lines.findIndex((line) => line.trim() === 'Patterns:')
  if (patternsIndex !== -1) {
    for (const line of lines.slice(patternsIndex + 1)) {
      const match = line.match(/^\s*-\s+(.*)$/)
      if (!match) break
      patterns.push(match[1]!)
    }
  }
  return { permission, patterns }
}

function normalizeOptions(options: unknown): Array<{ label: string; description: string }> {
  if (!Array.isArray(options)) return []
  return options
    .map((option) => {
      if (typeof option === 'string') return { label: option, description: '' }
      if (option && typeof option === 'object' && typeof (option as Json).label === 'string') {
        return { label: (option as Json).label, description: String((option as Json).description ?? '') }
      }
      return null
    })
    .filter((option): option is { label: string; description: string } => Boolean(option))
}

export function translateUiRequest({
  record,
  sessionID,
  toolMessageId,
}: {
  record: Json
  sessionID: string
  toolMessageId: (toolCallId: string) => string | undefined
}): UiRequestTranslation {
  const uiRequestId = typeof record.id === 'string' ? record.id : ''
  if (!uiRequestId) return { kind: 'ignore' }
  const toolCallId: string | undefined = typeof record.toolCallId === 'string' ? record.toolCallId : undefined
  const tool = toolCallId ? { messageID: toolMessageId(toolCallId) ?? '', callID: toolCallId } : undefined
  const base = { sessionID, uiRequestId, tool }

  switch (record.method) {
    case 'select': {
      const title = String(record.title ?? '')
      const options: string[] = Array.isArray(record.options) ? record.options.map(String) : []
      if (title.startsWith(PERMISSION_TITLE_PREFIX)) {
        const { permission, patterns } = parsePermissionTitle(title)
        const pending: PendingUiRequest = {
          ...base,
          requestID: `per_${uiRequestId}`,
          kind: 'permission',
          options,
          questionIds: [],
          questions: [],
        }
        return {
          kind: 'event',
          pending,
          event: {
            type: 'permission.asked',
            properties: {
              id: pending.requestID,
              sessionID,
              permission,
              patterns,
              metadata: { title },
              always: patterns,
              ...(tool ? { tool } : {}),
            },
          },
        }
      }
      const question: QuestionShape = {
        question: title || 'Choose an option',
        header: 'Select',
        options: options.map((label) => ({ label, description: '' })),
      }
      return questionEvent({ ...base, kind: 'select', options, questionIds: ['q1'], questions: [question] })
    }
    case 'confirm': {
      const text = [record.title, record.message].filter(Boolean).join('\n\n')
      const question: QuestionShape = {
        question: text || 'Confirm?',
        header: 'Confirm',
        options: [
          { label: CONFIRM_YES, description: '' },
          { label: CONFIRM_NO, description: '' },
        ],
      }
      return questionEvent({ ...base, kind: 'confirm', options: [CONFIRM_YES, CONFIRM_NO], questionIds: ['q1'], questions: [question] })
    }
    case 'question': {
      const rawQuestions: Json[] = Array.isArray(record.questions) ? record.questions : []
      const questions: QuestionShape[] = rawQuestions.map((q, index) => ({
        question: String(q.question ?? ''),
        header: String(q.header ?? q.id ?? `Question ${index + 1}`),
        options: normalizeOptions(q.options),
        multiple: q.multiSelect === true,
      }))
      return questionEvent({
        ...base,
        kind: 'question',
        options: [],
        questionIds: rawQuestions.map((q, index) => String(q.id ?? `q${index + 1}`)),
        questions,
      })
    }
    case 'input':
    case 'editor':
      return { kind: 'cancel', reason: `${record.method} dialogs are not supported in Discord` }
    case 'notify': {
      // Command output (/efforts, /tasks, ...) arrives as notifications.
      // dorimaki's toast handler drops `warning`, so warnings ride as info.
      if (typeof record.message !== 'string' || !record.message.trim()) return { kind: 'ignore' }
      const isError = record.notifyType === 'error'
      const prefix = record.notifyType === 'warning' ? '⚠️ ' : ''
      return {
        kind: 'toast',
        event: {
          type: 'tui.toast.show',
          properties: { message: `${prefix}${record.message} ${sessionID}`, variant: isError ? 'error' : 'info' },
        },
      }
    }
    default:
      return { kind: 'ignore' }
  }
}

function questionEvent(fields: Omit<PendingUiRequest, 'requestID'>): UiRequestTranslation {
  const pending: PendingUiRequest = { ...fields, requestID: `que_${fields.uiRequestId}` }
  return {
    kind: 'event',
    pending,
    event: {
      type: 'question.asked',
      properties: {
        id: pending.requestID,
        sessionID: pending.sessionID,
        questions: pending.questions,
        ...(pending.tool ? { tool: pending.tool } : {}),
      },
    },
  }
}

function pickOption(options: string[], patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = options.find((option) => pattern.test(option))
    if (match) return match
  }
  return undefined
}

/** `extension_ui_response` payload (without id/sessionId) for a permission reply. */
export function permissionResponse(pending: PendingUiRequest, reply: string): Json {
  const value = reply === 'always'
    ? pickOption(pending.options, [/^allow always/i, /always/i, /^allow/i])
    : reply === 'reject'
      ? pickOption(pending.options, [/^deny$/i, /^deny/i, /^block/i, /^reject/i])
      : pickOption(pending.options, [/^allow once/i, /^allow/i])
  if (!value) return { cancelled: true }
  return { value }
}

/** `extension_ui_response` payload for a Discord question answer (labels per question). */
export function questionResponse(pending: PendingUiRequest, answers: string[][]): Json {
  const first = answers[0]?.[0]
  if (pending.kind === 'confirm') {
    if (first === undefined) return { cancelled: true }
    return { confirmed: first === CONFIRM_YES }
  }
  if (pending.kind === 'select') {
    if (first === undefined) return { cancelled: true }
    return pending.options.includes(first) ? { value: first } : { cancelled: true }
  }
  const mapped: Json = {}
  pending.questions.forEach((question, index) => {
    const labels = answers[index] ?? []
    const optionLabels = new Set(question.options.map((option) => option.label))
    const selected = labels.filter((label) => optionLabels.has(label))
    const typed = labels.filter((label) => !optionLabels.has(label) && label.trim())
    if (selected.length === 0 && typed.length === 0) return
    mapped[pending.questionIds[index] ?? `q${index + 1}`] = {
      selected,
      ...(typed.length > 0 ? { text: typed.join('\n') } : {}),
    }
  })
  if (Object.keys(mapped).length === 0) return { cancelled: true }
  return { answers: mapped }
}
