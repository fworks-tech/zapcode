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

/** Webhook settings shared by the HTTP tests. */
const webhookConfig = {
  webhookSecret: 'secret',
  allowedNumber: '5511999999999',
}

/** Builds a valid direct-message payload with a customizable ID and JID. */
function payload(id = 'message-1', remoteJid = '5511999999999@s.whatsapp.net') {
  return {
    event: 'messages.upsert',
    data: {
      key: { id, remoteJid, fromMe: false },
      message: { conversation: 'Hello' } as Record<string, unknown>,
    },
  }
}

/** Verifies that reset stops response chunks that have not started sending. */
test('/reset stops old response chunks before the next send', async () => {
  /** Resolver for the first blocked WhatsApp send. */
  let release!: () => void
  /** Promise controlling the first chunk send. */
  const blocked = new Promise<void>((resolve) => { release = resolve })
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
      if (sends === 1) await blocked
      sent.push(text)
    },
    allowedNumber: webhookConfig.allowedNumber,
  })
  const pending = handler(webhookConfig.allowedNumber, 'long response')
  await new Promise<void>((resolve) => setImmediate(resolve))
  const resetting = handler(webhookConfig.allowedNumber, '/reset')
  await new Promise<void>((resolve) => setImmediate(resolve))
  release()
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

/** Verifies that the normal queue rejects a third waiting turn. */
test('message queue applies backpressure after one waiting turn', async () => {
  /** Resolver for the blocked first prompt. */
  let release!: () => void
  /** Promise keeping the first prompt active. */
  const blocked = new Promise<void>((resolve) => { release = resolve })
  /** Handler whose prompt never finishes until released. */
  const handler = createMessageHandler({
    prompt: async () => { await blocked; return 'done' },
    cancel: async () => undefined,
    reset: async () => undefined,
    decidePermission: async () => null,
    send: async () => undefined,
    allowedNumber: webhookConfig.allowedNumber,
  })
  const first = handler(webhookConfig.allowedNumber, 'first')
  const second = handler(webhookConfig.allowedNumber, 'second')
  await assert.rejects(handler(webhookConfig.allowedNumber, 'third'), QueueBusyError)
  release()
  await Promise.all([first, second])
})
