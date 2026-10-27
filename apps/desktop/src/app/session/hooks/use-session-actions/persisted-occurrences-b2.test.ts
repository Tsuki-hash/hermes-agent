import { expect, it } from 'vitest'

import { type ChatMessage, toChatMessages } from '@/lib/chat-messages'
import type { SessionMessage } from '@/types/hermes'

import { reconcilePersistedLiveTurn } from './persisted-live-turn'

const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } })

const assistantTexts = (messages: ChatMessage[]) =>
  messages.flatMap(message =>
    message.role === 'assistant' ? message.parts.flatMap(part => (part.type === 'text' ? [part.text.trim()] : [])) : []
  )

it.each(['', '\n', '\n\n', ' \n '])(
  'does not invent a separator between persisted stream occurrences (%j)',
  separator => {
    const first = 'Inspecting the first fixture.'
    const second = 'Inspecting the second fixture.'
    const suffix = 'The fixtures agree.'

    const rows: SessionMessage[] = [
      { id: 1, role: 'user', content: 'Inspect the fixtures' },
      { id: 2, role: 'assistant', content: first, tool_calls: [call('read-1')] },
      { id: 3, role: 'tool', content: 'First fixture', tool_call_id: 'read-1' },
      { id: 4, role: 'assistant', content: second, tool_calls: [call('read-2')] },
      { id: 5, role: 'tool', content: 'Second fixture', tool_call_id: 'read-2' }
    ]

    const durable = toChatMessages(rows)

    const projection = {
      session_id: 'synthetic-resume',
      inflight: { user: 'Inspect the fixtures', assistant: first + separator + second + suffix, streaming: true }
    }

    let current: ChatMessage[] = []

    for (let repeat = 0; repeat < 3; repeat++) {
      current = reconcilePersistedLiveTurn(durable, current, rows, projection)!
      expect(assistantTexts(current)).toEqual([first, second, suffix])
      expect(current.filter(message => message.pending)).toHaveLength(1)
    }
  }
)

it('covers shared tool occurrences despite a compaction stub and different stored narration', () => {
  const rows: SessionMessage[] = [
    { id: 1, role: 'user', content: 'Inspect the fixtures' },
    { id: 2, role: 'assistant', content: '', reasoning: 'Plan the reads.', tool_calls: [call('read-1')] },
    { id: 3, role: 'tool', content: 'First fixture', tool_call_id: 'read-1' },
    { id: 40, role: 'tool', content: '[pruned]', tool_call_id: 'earlier-turn-skill', timestamp: 0.5 },
    { id: 5, role: 'assistant', content: 'Checking.', tool_calls: [call('read-2')] }
  ]

  const durable = toChatMessages(rows)
  const tool = (id: string) => durable[1].parts.find(part => part.type === 'tool-call' && part.toolCallId === id)!

  const warm: ChatMessage[] = [
    durable[0],
    {
      id: 'live-0',
      role: 'assistant',
      interim: true,
      parts: [{ type: 'reasoning', text: 'Plan the reads, then compare.' }, tool('read-1')]
    },
    { id: 'live-1', role: 'assistant', pending: true, parts: [{ type: 'text', text: 'Checking.' }, tool('read-2')] }
  ]

  const result = reconcilePersistedLiveTurn(durable, warm, rows, {
    session_id: 'synthetic-resume',
    inflight: { user: 'Inspect the fixtures', assistant: 'Checking.', streaming: true }
  })!

  expect(
    result.flatMap(message => message.parts.flatMap(part => (part.type === 'tool-call' ? [part.toolCallId] : [])))
  ).toEqual(['read-1', 'earlier-turn-skill', 'read-2'])
  expect(assistantTexts(result)).toEqual(['Checking.'])
  expect(result.filter(message => message.pending)).toHaveLength(1)
})
