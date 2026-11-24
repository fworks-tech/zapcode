/**
 * HTTP, command, permission, and Evolution contract tests.
 *
 * @remarks
 * These tests use Supertest and small mocks so they exercise zapcode's own
 * boundaries without requiring Docker, WhatsApp, OpenCode, or an LLM.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'

import { PermissionBridge } from '../src/permissions.js'
import { createMessageHandler } from '../src/handler.js'
import { createApp } from '../src/app.js'
import { sendText } from '../src/whatsapp.js'

/** Shared webhook and Evolution settings used by the test cases. */
const config = {
  webhookSecret: 'secret',
  allowedNumber: '5511999999999',
  evolutionUrl: 'http://localhost:8080',
  evolutionApiKey: 'api-key',
  evolutionInstance: 'zapcode',
}

/**
 * Builds a valid Evolution `messages.upsert` payload.
 *
 * @returns A fresh payload that each test may safely mutate.
 */
function payload() {
  return {
    event: 'messages.upsert',
    instance: 'zapcode',
    data: {
      key: { id: 'message-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      message: { conversation: 'Hello' } as Record<string, unknown>,
    },
  }
}

/** Verifies that the webhook rejects missing and incorrect secrets. */
test('webhook rejects a missing or invalid secret', async () => {
  /** Express app under test with a no-op message handler. */
  const app = createApp(config, async () => undefined)
  await request(app).post('/webhook').send(payload()).expect(403)
  await request(app).post('/webhook').set('Webhook-Secret', 'wrong').send(payload()).expect(403)
})

/** Verifies that a different phone number cannot invoke the message handler. */
test('webhook blocks unauthorized numbers', async () => {
  /** Records whether the protected handler was incorrectly invoked. */
  let called = false
  /** Express app whose handler flips `called`. */
  const app = createApp(config, async () => { called = true })
  /** Payload mutated to simulate a different sender. */
  const body = payload()
  body.data.key.remoteJid = '5511888888888@s.whatsapp.net'
  await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(body).expect(403)
  assert.equal(called, false)
})

/** Verifies that duplicate delivery of one message ID is processed once. */
test('webhook processes valid text only once', async () => {
  /** Captures handler invocations in `sender:text` form. */
  const received: string[] = []
  /** Express app that records accepted messages. */
  const app = createApp(config, async (from, text) => { received.push(`${from}:${text}`) })
  await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(200)
  await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(200)
  assert.deepEqual(received, ['5511999999999:Hello'])
})

/** Verifies that unsupported events and message shapes are ignored. */
test('webhook ignores events, own messages, groups, and media', async () => {
  /** Records whether any unsupported payload reached the handler. */
  let called = false
  /** Express app whose handler flips `called`. */
  const app = createApp(config, async () => { called = true })
  /** Valid secret header reused across requests. */
  const headers = { 'Webhook-Secret': 'secret' }
  await request(app).post('/webhook').set(headers).send({ event: 'connection.update', data: {} }).expect(200)
  /** Payload representing a message sent by the linked account itself. */
  const own = payload()
  own.data.key.fromMe = true
  await request(app).post('/webhook').set(headers).send(own).expect(200)
  /** Payload representing a WhatsApp group. */
  const group = payload()
  group.data.key.remoteJid = '123@g.us'
  await request(app).post('/webhook').set(headers).send(group).expect(200)
  /** Payload representing an unsupported image message. */
  const media = payload()
  media.data.message = { imageMessage: {} }
  await request(app).post('/webhook').set(headers).send(media).expect(200)
  assert.equal(called, false)
})

/** Verifies that health checking does not depend on external services. */
test('health responds without OpenCode or Evolution', async () => {
  await request(createApp(config, async () => undefined)).get('/health').expect(200, { status: 'ok' })
})

/** Verifies local command handling for `/reset` and `/help`. */
test('/reset clears the session and /help does not call the model', async () => {
  /** Captures messages sent back to the owner. */
  const sent: string[] = []
  /** Records whether reset reached its dependency. */
  let reset = false
  /** Counts normal model prompts. */
  let prompts = 0
  /** Handler with instrumented prompt, reset, and delivery dependencies. */
  const handler = createMessageHandler({
    prompt: async () => { prompts++; return 'response' },
    cancel: async () => undefined,
    reset: async () => { reset = true },
    decidePermission: async () => null,
    send: async (_to, text) => { sent.push(text) },
    allowedNumber: config.allowedNumber,
  })
  await handler('5511999999999', '/reset')
  await handler('5511999999999', '/help')
  assert.equal(reset, true)
  assert.equal(prompts, 0)
  assert.match(sent[0] ?? '', /Saved session/)
  assert.match(sent[1] ?? '', /\/yes/)
})

/** Verifies that reset cancels active work instead of waiting behind it. */
test('/reset cancels the active prompt without waiting for the queue', async () => {
  /** Resolver used to release the deliberately blocked prompt. */
  let release!: () => void
  /** Promise that keeps the normal prompt pending until reset releases it. */
  const blocked = new Promise<void>((resolve) => { release = resolve })
  /** Captures messages sent back to the owner. */
  const sent: string[] = []
  /** Records whether cancellation was requested. */
  let cancelled = false
  /** Records whether session reset was requested. */
  let reset = false
  /** Handler whose cancel dependency releases the blocked prompt. */
  const handler = createMessageHandler({
    prompt: async () => { await blocked; return 'old response' },
    cancel: async () => { cancelled = true; release() },
    reset: async () => { reset = true },
    decidePermission: async () => null,
    send: async (_to, text) => { sent.push(text) },
    allowedNumber: config.allowedNumber,
  })
  /** Pending normal prompt started before reset. */
  const pending = handler('5511999999999', 'long task')
  await new Promise<void>((resolve) => setImmediate(resolve))
  await handler('5511999999999', '/reset')
  await pending
  assert.equal(cancelled, true)
  assert.equal(reset, true)
  assert.deepEqual(sent, ['Saved session cleared. Your next message starts with a clean context.'])
})

/** Verifies that permission approval bypasses the blocked prompt queue. */
test('/yes does not get stuck behind a prompt waiting for permission', async () => {
  /** Resolver used to release the deliberately blocked prompt. */
  let release!: () => void
  /** Promise that simulates OpenCode waiting for permission. */
  const blocked = new Promise<void>((resolve) => { release = resolve })
  /** Records whether the permission command was handled. */
  let decided = false
  /** Handler whose permission decision releases the blocked prompt. */
  const handler = createMessageHandler({
    prompt: async () => { await blocked; return 'response' },
    cancel: async () => undefined,
    reset: async () => undefined,
    decidePermission: async () => { decided = true; release(); return 'Permission granted' },
    send: async () => undefined,
    allowedNumber: config.allowedNumber,
  })
  /** Pending prompt that waits for the permission reply. */
  const pending = handler('5511999999999', 'Edit the file')
  await new Promise<void>((resolve) => setImmediate(resolve))
  await handler('5511999999999', '/yes perm-1')
  assert.equal(decided, true)
  await pending
})

/** Verifies permission delivery, one-time approval, and duplicate handling. */
test('PermissionBridge forwards requests and decides once', async () => {
  /** Captures approval prompts sent to WhatsApp. */
  const sent: string[] = []
  /** Captures decisions sent back to OpenCode. */
  const replies: unknown[] = []
  /** Produces one permission event for the mocked stream. */
  async function* events() {
    yield { type: 'permission.asked', data: { id: 'perm-1', sessionID: 'session-1', action: 'edit', resources: ['src/index.ts'] } }
  }
  /** Mock OpenCode event and permission APIs. */
  const client = {
    event: { subscribe: async () => events() },
    permission: {
      reply: async (input: unknown) => { replies.push(input) },
      request: { list: async () => ({ data: [] }) },
    },
  }
  /** Permission bridge restricted to the `/repo` workdir. */
  const permissions = new PermissionBridge(client as never, async (_to, text) => { sent.push(text) }, config.allowedNumber, '/repo')
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', location: { directory: '/repo' }, data: { id: 'perm-1', sessionID: 'session-1', action: 'edit', resources: ['src/index.ts'] } })
  assert.match(sent[0] ?? '', /perm-1/)
  permissions.handleEvent({ type: 'permission.asked', location: { directory: '/other-project' }, data: { id: 'perm-2', sessionID: 'session-2', action: 'shell', resources: ['rm *'] } })
  assert.equal(sent.length, 1)
  assert.match(await permissions.decide('/yes perm-1') ?? '', /Permission granted/)
  assert.deepEqual(replies, [{ sessionID: 'session-1', requestID: 'perm-1', decision: 'once' }])
  assert.match(await permissions.decide('/yes perm-1') ?? '', /No pending permission/)
  permissions.handleEvent({ type: 'permission.asked', location: { directory: '/repo' }, data: { id: 'perm-2', sessionID: 'session-1', action: 'shell', resources: ['git status'] } })
  assert.match(await permissions.decide('/no perm-2') ?? '', /rejected/)
  assert.deepEqual(replies[1], { sessionID: 'session-1', requestID: 'perm-2', decision: 'reject' })
})

/** Verifies that `/no` rejects all requests belonging to one session. */
test('PermissionBridge explicitly rejects every request in the same session', async () => {
  /** Captures decisions sent back to OpenCode. */
  const replies: unknown[] = []
  /** Mock client that records every permission reply. */
  const client = { permission: { reply: async (input: unknown) => { replies.push(input) }, request: { list: async () => ({ data: [] }) } } }
  /** Permission bridge under test. */
  const permissions = new PermissionBridge(client as never, async () => undefined, config.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: { id: 'perm-1', sessionID: 'session-1', action: 'shell', resources: ['rm *'] } })
  permissions.handleEvent({ type: 'permission.asked', data: { id: 'perm-2', sessionID: 'session-1', action: 'edit', resources: ['src/index.ts'] } })
  permissions.handleEvent({ type: 'permission.asked', data: { id: 'perm-3', sessionID: 'session-2', action: 'shell', resources: ['git status'] } })
  assert.match(await permissions.decide('/no perm-1') ?? '', /rejected/)
  assert.deepEqual(replies, [
    { sessionID: 'session-1', requestID: 'perm-1', decision: 'reject' },
    { sessionID: 'session-1', requestID: 'perm-2', decision: 'reject' },
  ])
  assert.match(await permissions.decide('/yes perm-3') ?? '', /No pending permission/)
})

/** Verifies that failed rejection leaves the request available for retry. */
test('PermissionBridge keeps a request pending when rejection fails', async (t) => {
  t.mock.method(console, 'error', () => undefined)
  /** Captures every attempted permission reply. */
  const replies: unknown[] = []
  /** Mock client that fails exactly one rejection. */
  const client = {
    permission: {
      reply: async (input: { requestID: string; decision: string }) => {
        replies.push(input)
        if (input.requestID === 'perm-2' && input.decision === 'reject') throw new Error('failure')
      },
      request: { list: async () => ({ data: [] }) },
    },
  }
  /** Permission bridge under test. */
  const permissions = new PermissionBridge(client as never, async () => undefined, config.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: { id: 'perm-1', sessionID: 'session-1', action: 'shell', resources: ['rm *'] } })
  permissions.handleEvent({ type: 'permission.asked', data: { id: 'perm-2', sessionID: 'session-1', action: 'edit', resources: ['src/index.ts'] } })
  assert.match(await permissions.decide('/no perm-1') ?? '', /Failed to reject 1/)
  assert.match(await permissions.decide('/yes perm-2') ?? '', /granted/)
  assert.equal(replies.length, 3)
})

/** Verifies that stream establishment precedes pending-request reconciliation. */
test('PermissionBridge establishes the stream before reconciling pending requests', async () => {
  /** Records the order of subscription and list operations. */
  const order: string[] = []
  /** Resolver used to release the test after the list operation starts. */
  let finishList!: () => void
  /** Promise resolved by the mocked pending-request list call. */
  const listed = new Promise<void>((resolve) => { finishList = resolve })
  /** Mock event stream that emits one connection event and then stays open. */
  const client = {
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => {
          /** Tracks whether the initial connection event was emitted. */
          let first = true
          return {
            next: async () => {
              order.push('subscribe')
              if (first) {
                first = false
                return { done: false as const, value: { type: 'server.connected' } }
              }
              return new Promise<never>(() => undefined)
            },
          }
        },
      }),
    },
    permission: {
      request: {
        list: async () => {
          order.push('list')
          finishList()
          return { data: [] }
        },
      },
    },
  }
  /** Permission bridge started with the ordered mock client. */
  const permissions = new PermissionBridge(client as never, async () => undefined, config.allowedNumber)
  permissions.start()
  await listed
  permissions.stop()
  assert.deepEqual(order, ['subscribe', 'list'])
})

/** Verifies the Evolution text payload and HTTP error propagation. */
test('sendText uses the Evolution textMessage contract and fails on HTTP errors', async () => {
  /** Captures the URL passed to the injected fetch implementation. */
  let calledUrl = ''
  /** Captures the request options passed to the injected fetch implementation. */
  let calledInit: RequestInit | undefined
  /** Fetch mock that records the request and returns HTTP 200. */
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    calledUrl = String(url)
    calledInit = init
    return new Response('{}', { status: 200 })
  }
  await sendText(config, '5511999999999', 'Hello', fakeFetch)
  assert.equal(calledUrl, 'http://localhost:8080/message/sendText/zapcode')
  /** Headers extracted from the captured request. */
  const headers = new Headers(calledInit?.headers)
  assert.equal(headers.get('apikey'), 'api-key')
  assert.deepEqual(JSON.parse(String(calledInit?.body)), { number: '5511999999999', textMessage: { text: 'Hello' } })
  await assert.rejects(sendText(config, '5511999999999', 'Hello', async () => new Response('failed', { status: 500 })), /500/)
})
