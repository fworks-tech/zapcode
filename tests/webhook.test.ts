/**
 * Express webhook boundary tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'

import { createApp } from '../src/app.js'
import { payload, webhookConfig as config } from './helpers/webhook.js'

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
