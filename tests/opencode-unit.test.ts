/**
 * OpenCode prompt, cancellation, and authentication unit tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { cancelExecution, createOpenCode, extractReply, promptWithContext } from '../src/opencode.js'

test('promptWithContext injects knowledge and extracts the latest text response', async () => {
  /** Captures the final prompt text sent to OpenCode. */
  let promptText = ''
  /** Counts message-list calls before and after execution. */
  let call = 0
  /** Mock client returning an old response first and a new response second. */
  const client = {
    session: {
      prompt: async ({ id, text }: { id?: string; text: string }) => {
        assert.equal(id, 'msg-test')
        promptText = text
        return { data: { id: 'user-1' } }
      },
    },
    experimental: { session: { wait: async () => undefined } },
    message: {
      list: async () => {
        call++
        return call === 1
          ? { data: [{ id: 'old-assistant', type: 'assistant', content: [{ type: 'text', text: 'old' }] }] }
          : { data: [
              { id: 'new-assistant', type: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'Response' }] },
              { id: 'old-assistant', type: 'assistant', content: [{ type: 'text', text: 'old' }] },
            ] }
      },
    },
  }
  /** Response returned by the contextualized prompt helper. */
  const result = await promptWithContext(client as never, 'session-1', {
    text: 'What is the answer?',
    knowledge: ['faq.md:\nFAQ content'],
    promptID: 'msg-test',
  })
  assert.match(promptText, /FAQ content/)
  assert.match(promptText, /What is the answer\?/)
  assert.equal(result, 'Response')
  assert.equal(extractReply({ data: [] }), 'OpenCode finished without a text response.')
})

/** Verifies that an already-stale execution never calls OpenCode. */
test('promptWithContext does not admit a prompt when the execution is already stale', async () => {
  /** Records whether prompt admission was incorrectly attempted. */
  let admitted = false
  /** Counts message-list calls, which must also remain at zero. */
  let listCalls = 0
  /** Mock client with admission and message-list spies. */
  const client = {
    message: { list: async () => { listCalls++; return { data: [] } } },
    session: { prompt: async () => { admitted = true; return { id: 'msg-old' } } },
    experimental: { session: { wait: async () => undefined } },
  }
  await assert.rejects(promptWithContext(client as never, 'session-1', {
    text: 'old task',
    knowledge: [],
    promptID: 'msg-old',
    isCurrent: () => false,
  }), /cancelled/)
  assert.equal(admitted, false)
  assert.equal(listCalls, 0)
})

/** Verifies cancellation when reset invalidates the run during admission. */
test('promptWithContext leaves stale cancellation to the reset owner', async () => {
  /** Mutable generation flag flipped by the mocked prompt call. */
  let current = true
  /** Captures inbox cancellation requests. */
  const cancelled: unknown[] = []
  /** Captures session interruption requests. */
  const interrupted: unknown[] = []
  /** Counts message-list calls around prompt admission. */
  let listCalls = 0
  /** Mock client that invalidates the run inside `session.prompt()`. */
  const client = {
    message: {
      list: async () => {
        listCalls++
        return listCalls === 1
          ? { data: [] }
          : { data: [{ id: 'assistant-1', type: 'assistant', content: [{ type: 'text', text: 'response' }] }] }
      },
    },
    session: {
      prompt: async () => { current = false; return { id: 'msg-race' } },
      inbox: { cancel: async (input: unknown) => { cancelled.push(input) } },
      interrupt: async (input: unknown) => { interrupted.push(input); return { interrupted: true } },
    },
    experimental: { session: { wait: async () => undefined } },
  }
  await assert.rejects(promptWithContext(client as never, 'session-1', {
    text: 'old task',
    knowledge: [],
    promptID: 'msg-race',
    isCurrent: () => current,
  }), /cancelled/)
  assert.deepEqual(cancelled, [])
  assert.deepEqual(interrupted, [])
})

/** Verifies that partial cancellation failure is surfaced to the caller. */
test('cancelExecution fails when cancellation cannot be confirmed', async (t) => {
  t.mock.method(console, 'error', () => undefined)
  /** Mock client whose inbox cancellation always fails. */
  const client = {
    session: {
      inbox: { cancel: async () => { throw new Error('no connection') } },
      interrupt: async () => ({}),
    },
  }
  await assert.rejects(cancelExecution(client as never, 'session-1', 'msg-1'), /confirm execution cancellation/)
})

/** Verifies timeout cleanup cancels both the inbox item and session execution. */
test('promptWithContext cancels the inbox and interrupts on timeout', async () => {
  /** Original timeout function restored after the test. */
  const originalTimeout = AbortSignal.timeout
  /** Manually controlled signal used to simulate the 55-second deadline. */
  const controller = new AbortController()
  /** Captures inbox cancellation requests. */
  const cancelled: unknown[] = []
  /** Captures session interruption requests. */
  const interrupted: unknown[] = []
  /** Captures the stable prompt ID passed during admission. */
  let promptID: string | undefined
  /** Mock client that aborts immediately after prompt admission. */
  const client = {
    message: { list: async () => ({ data: [] }) },
    session: {
      prompt: async ({ id }: { id?: string }) => {
        promptID = id
        controller.abort()
        return { id }
      },
      inbox: { cancel: async (input: unknown) => { cancelled.push(input) } },
      interrupt: async (input: unknown) => { interrupted.push(input); return { interrupted: true } },
    },
    experimental: {
      session: {
        wait: async (_input: unknown, options: { signal: AbortSignal }) => {
          if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        },
      },
    },
  }
  AbortSignal.timeout = () => controller.signal
  try {
    await assert.rejects(promptWithContext(client as never, 'session-1', {
      text: 'long task',
      knowledge: [],
      promptID: 'msg-timeout',
    }), /55s timeout/)
  } finally {
    AbortSignal.timeout = originalTimeout
  }
  assert.equal(promptID, 'msg-timeout')
  assert.deepEqual(cancelled, [{ sessionID: 'session-1', inboxID: 'msg-timeout' }])
  assert.deepEqual(interrupted, [{ sessionID: 'session-1' }])
})

/** Verifies that the generated client sends the expected Basic auth header. */
test('createOpenCode sends Basic auth on requests', async () => {
  /** Original global fetch restored after the test. */
  const originalFetch = globalThis.fetch
  /** Captures the authorization header from the mocked request. */
  let authorization: string | null = null
  /** Fetch mock that records headers and returns an empty JSON response. */
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization')
    return Response.json({})
  }
  try {
    /** Client created with known test credentials. */
    const client = createOpenCode('http://127.0.0.1:4096', 'opencode-password')
    await client.server.info()
    assert.equal(authorization, `Basic ${Buffer.from('opencode:opencode-password').toString('base64')}`)
  } finally {
    globalThis.fetch = originalFetch
  }
})
