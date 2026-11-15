/** Tests omo history conversion keeps Discord-origin and extension-injected user turns out of external sync. */

import { describe, expect, test } from 'vitest'
import {
  getRenderableUserTextParts,
  isLatestUserTurnFromDiscord,
  type SessionMessageLike,
} from '../external-opencode-sync.js'
import { agentMessagesToOpencode } from './messages.js'

const discordTag = '<discord-user name="alice" message-id="m1" thread-id="t1" />'

function convert(messages: Record<string, unknown>[]): SessionMessageLike[] {
  return agentMessagesToOpencode({ sessionID: 'ses_1', messages, cwd: '/tmp' }) as unknown as SessionMessageLike[]
}

function user(text: string, timestamp: number) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp }
}

function assistant(text: string, timestamp: number) {
  return { role: 'assistant', content: [{ type: 'text', text }], timestamp, stopReason: 'stop' }
}

function context(content: string, timestamp: number) {
  return { role: 'custom', customType: 'dorimaki-context', content, display: false, timestamp }
}

describe('agentMessagesToOpencode', () => {
  test('folds dorimaki-context into the user message so the Discord origin is detected', () => {
    const converted = convert([user('hello', 1), context(discordTag, 2), assistant('hi', 3)])

    expect(isLatestUserTurnFromDiscord({ messages: converted })).toBe(true)
    expect(getRenderableUserTextParts({ message: converted[0]! }).map((p) => p.text)).toEqual(['hello'])
  })

  test('attaches context that arrives before its user message', () => {
    const converted = convert([assistant('earlier', 1), context(discordTag, 2), user('hello', 3)])

    expect(isLatestUserTurnFromDiscord({ messages: converted })).toBe(true)
  })

  test('extension-injected user messages do not make the session look externally resumed', () => {
    const converted = convert([
      user('hello', 1),
      context(discordTag, 2),
      assistant('asking a question', 3),
      user('[Answer to question toolu_1]\nThe user did not answer within 30 minutes.', 4),
      assistant('continuing', 5),
    ])

    expect(isLatestUserTurnFromDiscord({ messages: converted })).toBe(true)
    expect(getRenderableUserTextParts({ message: converted[2]! })).toEqual([])
  })
})
