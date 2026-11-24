/**
 * Core unit tests for configuration, parsing, sessions, and OpenCode calls.
 *
 * @remarks
 * OpenCode and network boundaries are mocked. These tests verify zapcode's
 * request shapes and lifecycle decisions without executing a model.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadConfig } from '../src/config.js'
import { cancelExecution, createOpenCode, extractReply, promptWithContext } from '../src/opencode.js'
import { SAFE_PERMISSIONS } from '../src/permissions.js'
import { SessionStore } from '../src/session.js'
import { chunkText } from '../src/whatsapp.js'
import { extractIncoming, normalizeNumber } from '../src/webhook.js'
import { loadKnowledge } from '../src/knowledge.js'

/** Environment variables temporarily cleared by the configuration test. */
const envKeys = ['OPENCODE_URL', 'OPENCODE_PASSWORD', 'WORKDIR', 'EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE', 'ALLOWED_NUMBER', 'WEBHOOK_SECRET']

/**
 * Resolves the effective permission effect using V2's last-match behavior.
 *
 * @param action - Permission action to evaluate.
 * @param resource - Resource string to match against each rule.
 * @returns The last matching effect, or `undefined` when no rule matches.
 */
function permissionEffect(action: string, resource: string): string | undefined {
  /** Effect produced by the most recently matching rule. */
  let effect: string | undefined
  for (const rule of SAFE_PERMISSIONS) {
    if (rule.action !== action && rule.action !== '*') continue
    /** Rule resource converted from glob syntax to an anchored regular expression. */
    const pattern = rule.resource.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    if (new RegExp(`^${pattern}$`, 'i').test(resource)) effect = rule.effect
  }
  return effect
}

/** Verifies that missing mandatory configuration fails immediately. */
test('config requires every mandatory variable', () => {
  /** Snapshot of environment values restored after the test. */
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  try {
    assert.throws(() => loadConfig(), /OPENCODE_URL/)
  } finally {
    for (const key of envKeys) {
      if (saved[key] !== undefined) process.env[key] = saved[key]
    }
  }
})

/** Verifies number normalization and rejection of example secret placeholders. */
test('config normalizes the number and rejects secret placeholders', () => {
  /** Complete valid environment used as the baseline for assertions. */
  const valid = {
    OPENCODE_URL: 'http://127.0.0.1:4096/',
    OPENCODE_PASSWORD: 'opencode-password-with-32-characters',
    WORKDIR: '.',
    EVOLUTION_API_URL: 'http://127.0.0.1:8080/',
    EVOLUTION_API_KEY: 'evolution-key-with-32-characters',
    EVOLUTION_INSTANCE: 'zapcode',
    ALLOWED_NUMBER: '+55 (11) 99999-9999',
    WEBHOOK_SECRET: 'webhook-secret-with-32-characters',
  }
  assert.equal(loadConfig(valid).allowedNumber, '5511999999999')
  assert.equal(loadConfig(valid).openCodeUrl, 'http://127.0.0.1:4096')
  assert.equal(loadConfig(valid).openCodePassword, 'opencode-password-with-32-characters')
  assert.throws(() => loadConfig({ ...valid, WEBHOOK_SECRET: 'replace-with-another-random-32-byte-secret' }), /WEBHOOK_SECRET/)
  assert.throws(() => loadConfig({ ...valid, OPENCODE_PASSWORD: 'replace-with-an-opencode-password' }), /OPENCODE_PASSWORD/)
})

/** Verifies that specific denies override broad allows and risky tools stay blocked. */
test('permissions deny .env after broad allows and block grep/subagents', () => {
  assert.equal(permissionEffect('read', '.env'), 'deny')
  assert.equal(permissionEffect('read', 'secrets/.env.local'), 'deny')
  assert.equal(permissionEffect('read', 'src/index.ts'), 'ask')
  assert.equal(permissionEffect('edit', '.env'), 'deny')
  assert.equal(permissionEffect('grep', '.*'), 'deny')
  assert.equal(permissionEffect('subagent', 'general'), 'deny')
})

/** Verifies JID and formatted phone-number normalization. */
test('normalizeNumber accepts JIDs and formatted numbers', () => {
  assert.equal(normalizeNumber('5511999999999:12@s.whatsapp.net'), '5511999999999')
  assert.equal(normalizeNumber('+55 (11) 99999-9999'), '5511999999999')
})

/** Verifies that only direct incoming text messages are extracted. */
test('extractIncoming only accepts text in direct incoming conversations', () => {
  /** Minimal valid payload reused across shape variations. */
  const base = { event: 'messages.upsert', data: { key: { id: 'm1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false } } }
  assert.deepEqual(extractIncoming(base), { from: '5511999999999', text: undefined, id: 'm1' })
  assert.equal(extractIncoming({ ...base, data: { ...base.data, message: { conversation: 'Hello' } } })?.text, 'Hello')
  assert.equal(extractIncoming({ ...base, data: { ...base.data, message: { extendedTextMessage: { text: 'Hello' } } } })?.text, 'Hello')
  assert.equal(extractIncoming({ ...base, data: { ...base.data, key: { ...base.data.key, fromMe: true } } }), null)
  assert.equal(extractIncoming({ ...base, data: { ...base.data, key: { ...base.data.key, remoteJid: '123@g.us' } } }), null)
  assert.equal(extractIncoming({ ...base, data: { ...base.data, message: { imageMessage: {} } } }), null)
})

/** Verifies chunk ordering, lossless joining, word boundaries, and Unicode safety. */
test('chunkText preserves text and respects the limit without splitting words', () => {
  assert.deepEqual(chunkText('short', 10), ['short'])
  /** Long input designed to require multiple word-aware chunks. */
  const text = ('word '.repeat(30) + '\n').repeat(20)
  /** Chunks produced for the long input. */
  const chunks = chunkText(text, 100)
  assert.ok(chunks.length > 1)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every((chunk) => chunk.length <= 100))
  /** Input with no whitespace, forcing hard character boundaries. */
  const unbroken = 'a'.repeat(25)
  assert.deepEqual(chunkText(unbroken, 10), ['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaa'])
  assert.deepEqual(chunkText('😀', 1), ['😀'])
})

/** Verifies deterministic Markdown-only knowledge loading. */
test('loadKnowledge reads only Markdown deterministically', async () => {
  /** Temporary knowledge directory created for this test. */
  const directory = await mkdtemp(path.join(tmpdir(), 'zapcode-knowledge-'))
  try {
    await writeFile(path.join(directory, 'b.md'), 'B')
    await writeFile(path.join(directory, 'a.md'), 'A')
    await writeFile(path.join(directory, 'ignored.txt'), 'ignored')
    assert.deepEqual(await loadKnowledge(directory), ['a.md:\nA', 'b.md:\nB'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** Verifies session creation, persistence across store instances, and reset. */
test('SessionStore creates once and reuses the session after restart', async () => {
  /** Temporary directory that holds the session file. */
  const directory = await mkdtemp(path.join(tmpdir(), 'zapcode-session-'))
  /** Session JSON path inside the temporary directory. */
  const file = path.join(directory, 'session.json')
  /** Counts calls to the mocked OpenCode session-creation API. */
  let creates = 0
  /** Mock OpenCode client that validates creation input. */
  const client = {
    session: {
      create: async (input: { location: { directory: string }; permissions: unknown }) => {
        assert.equal(input.location.directory, '/repo')
        assert.deepEqual(input.permissions, SAFE_PERMISSIONS)
        return { id: `session-${++creates}` }
      },
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, location: { directory: '/repo' } }),
      update: async ({ sessionID, permissions }: { sessionID: string; permissions: unknown }) => {
        assert.equal(sessionID, 'session-1')
        assert.deepEqual(permissions, SAFE_PERMISSIONS)
      },
      remove: async () => undefined,
    },
  }
  try {
    /** First store instance creates the initial session. */
    const first = new SessionStore(client as never, '/repo', file)
    assert.equal(await first.ensure(), 'session-1')
    assert.equal(await new SessionStore(client as never, '/repo', file).ensure(), 'session-1')
    assert.equal(creates, 1)
    await first.reset()
    assert.equal(await first.ensure(), 'session-2')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** Verifies knowledge injection and extraction of the newest assistant text. */
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
