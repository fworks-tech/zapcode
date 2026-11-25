/**
 * Handler and webhook regression tests.
 *
 * @remarks
 * Covers reset-safe response delivery, retry/dedup behavior, authentication
 * order, strict JIDs, busy retries, and queue backpressure.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'

import { createApp } from '../src/app.js'
import { createMessageHandler, QueueBusyError } from '../src/handler.js'
import { deferred } from './helpers/runtime.js'
import { payload, webhookConfig } from './helpers/webhook.js'

/** Verifies that reset stops response chunks that have not started sending. */
test('/reset stops old response chunks before the next send', async () => {
  /** Promise controlling the first chunk send. */
  const blocked = deferred<void>()
  /** Captures delivered chunks in order. */
  const sent: string[] = []
  /** Counts send calls. */
  let sends = 0
  /** Handler with a long response and a blocking first send. */
  const handler = createMessageHandler({
    prompt: async () => 'x'.repeat(7_001),
    cancel: async () => undefined,
    reset: async () => undefined,
    decidePermission: async () => null,
    send: async (_to, text) => {
      sends++
      if (sends === 1) await blocked.promise
      sent.push(text)
    },
    allowedNumber: webhookConfig.allowedNumber,
  })
  const pending = handler(webhookConfig.allowedNumber, 'long response')
  await new Promise<void>((resolve) => setImmediate(resolve))
  const resetting = handler(webhookConfig.allowedNumber, '/reset')
  await new Promise<void>((resolve) => setImmediate(resolve))
  blocked.resolve()
  await Promise.all([pending, resetting])
  assert.equal(sent.length, 2)
  assert.equal(sent[0]?.length, 3_500)
  assert.match(sent[1] ?? '', /Saved session cleared/)
})

/** Verifies that a retryable handler failure releases the message ID. */
test('webhook retries the same ID after a retryable failure', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Counts handler attempts. */
  let calls = 0
  /** First call fails before admission; the retry succeeds. */
  const app = createApp(webhookConfig, async () => {
    calls++
    if (calls === 1) throw Object.assign(new Error('retry'), { retryable: true })
  })
  await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(500)
  await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(200)
  assert.equal(calls, 2)
})

/** Verifies that a non-retryable failure is not executed twice. */
test('webhook deduplicates a non-retryable failed message', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Counts handler attempts. */
  let calls = 0
  /** Handler always fails after side effects. */
  const app = createApp(webhookConfig, async () => {
    calls++
    throw Object.assign(new Error('failed'), { retryable: false })
  })
  await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(500)
  await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(200, { duplicate: true })
  assert.equal(calls, 1)
})

/** Verifies that malformed unauthenticated JSON is rejected before parsing. */
test('webhook authenticates before parsing JSON', async () => {
  const app = createApp(webhookConfig, async () => undefined)
  await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .send('{broken')
    .expect(403)
})

/** Verifies that a busy queue response releases the ID for retry. */
test('webhook can retry a message after a busy response', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Counts handler attempts. */
  let calls = 0
  const app = createApp(webhookConfig, async () => {
    calls++
    if (calls === 1) throw new QueueBusyError()
  })
  await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(429)
  await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(200)
  assert.equal(calls, 2)
})

/** Verifies that supported text payloads require a non-empty string ID. */
test('webhook rejects supported text with a missing or invalid message ID', async () => {
  /** Counts handler calls. */
  let calls = 0
  const app = createApp(webhookConfig, async () => { calls++ })
  for (const id of [undefined, '', '   ', 42]) {
    /** Payload mutated to exercise one invalid ID shape. */
    const body = payload()
    if (id === undefined) delete (body.data.key as { id?: string }).id
    else (body.data.key as { id?: unknown }).id = id
    await request(app)
      .post('/webhook')
      .set('Webhook-Secret', 'secret')
      .send(body)
      .expect(400, { error: 'missing message id' })
  }
  assert.equal(calls, 0)
})

/** Verifies strict direct JID validation and unauthorized-media handling. */
test('webhook rejects malformed JIDs and blocks unauthorized direct media', async () => {
  /** Counts handler calls. */
  let calls = 0
  const app = createApp(webhookConfig, async () => { calls++ })
  const malformed = payload('bad-jid', 'prefix-5511999999999@s.whatsapp.net')
  await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(malformed).expect(400)
  const unauthorized = payload('unauthorized-media', '5511888888888@s.whatsapp.net')
  unauthorized.data.message = { imageMessage: {} }
  await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(unauthorized).expect(403)
  assert.equal(calls, 0)
})

/** Verifies that a failed confirmation does not report a successful permission as failed. */
test('permission confirmation failure does not change a successful decision', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Records whether the server decision ran. */
  let decided = false
  /** Counts confirmation attempts. */
  let sends = 0
  const handler = createMessageHandler({
    prompt: async () => 'response',
    cancel: async () => undefined,
    reset: async () => undefined,
    decidePermission: async () => { decided = true; return 'granted' },
    send: async () => { sends++; throw new Error('WhatsApp unavailable') },
    allowedNumber: webhookConfig.allowedNumber,
  })
  await handler(webhookConfig.allowedNumber, '/yes perm-1')
  assert.equal(decided, true)
  assert.equal(sends, 1)
})

/** Verifies that a failed confirmation does not report a successful reset as failed. */
test('reset confirmation failure does not change successful cleanup', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Records whether reset cleanup ran. */
  let reset = false
  /** Counts confirmation attempts. */
  let sends = 0
  const handler = createMessageHandler({
    prompt: async () => 'response',
    cancel: async () => undefined,
    reset: async () => { reset = true },
    decidePermission: async () => null,
    send: async () => { sends++; throw new Error('WhatsApp unavailable') },
    allowedNumber: webhookConfig.allowedNumber,
  })
  await handler(webhookConfig.allowedNumber, '/reset')
  assert.equal(reset, true)
  assert.equal(sends, 1)
})

/** Verifies that the normal queue rejects a third waiting turn. */
test('message queue applies backpressure after one waiting turn', async () => {
  /** Promise keeping the first prompt active. */
  const blocked = deferred<void>()
  /** Handler whose prompt never finishes until released. */
  const handler = createMessageHandler({
    prompt: async () => { await blocked.promise; return 'done' },
    cancel: async () => undefined,
    reset: async () => undefined,
    decidePermission: async () => null,
    send: async () => undefined,
    allowedNumber: webhookConfig.allowedNumber,
  })
  const first = handler(webhookConfig.allowedNumber, 'first')
  const second = handler(webhookConfig.allowedNumber, 'second')
  await assert.rejects(handler(webhookConfig.allowedNumber, 'third'), QueueBusyError)
  blocked.resolve()
  await Promise.all([first, second])
})
