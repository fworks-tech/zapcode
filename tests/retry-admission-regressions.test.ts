/**
 * Runtime-to-webhook retry classification regression tests.
 *
 * @remarks
 * Exercises the real handler and runtime around a mocked OpenCode boundary so
 * pre-admission failures release message IDs while uncertain admitted work does
 * not run twice.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'

import { createApp } from '../src/app.js'
import { KnowledgeLimitError } from '../src/knowledge.js'
import { SessionConfigurationError, SessionStore } from '../src/session.js'
import { createRuntimeHarness } from './helpers/runtime.js'
import { withTempFile } from './helpers/temp.js'
import { payload, webhookConfig } from './helpers/webhook.js'

/** Verifies that deterministic setup failures stay deduplicated at the webhook. */
async function expectPermanentSetupDeduplicated(error: Error): Promise<void> {
  /** Counts session setup attempts. */
  let attempts = 0
  const harness = createRuntimeHarness({
    sessions: {
      ensure: async () => {
        attempts++
        throw error
      },
    },
  })
  try {
    const app = createApp(webhookConfig, harness.runtime.handler)
    await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(500)
    await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(200, { duplicate: true })
    assert.equal(attempts, 1)
  } finally {
    harness.restore()
  }
}

/** Verifies that a pre-admission runtime failure releases the webhook message ID. */
test('pre-admission failure releases the message ID and retries through the runtime', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Counts prompt admissions. */
  let prompts = 0
  /** Counts pre-prompt assistant-list calls. */
  let beforeLists = 0
  const harness = createRuntimeHarness({
    client: {
      message: {
        list: async ({ limit }: { limit: number }) => {
          if (limit === 1) {
            beforeLists++
            if (beforeLists === 1) throw new TypeError('temporary')
            return { data: [] }
          }
          return { data: [{ id: 'assistant-new', type: 'assistant', content: [{ type: 'text', text: 'done' }] }] }
        },
      },
      session: { prompt: async () => { prompts++; return {} } },
      experimental: { session: { wait: async () => ({}) } },
    },
  })
  try {
    const app = createApp(webhookConfig, harness.runtime.handler)
    await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(500)
    await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(200, { ok: true })
    assert.equal(prompts, 1)
  } finally {
    harness.restore()
  }
})

/** Verifies that permanent configuration and knowledge failures are not retried. */
test('permanent setup failures remain deduplicated by the webhook', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  await expectPermanentSetupDeduplicated(new SessionConfigurationError('WORKDIR mismatch'))
  await expectPermanentSetupDeduplicated(new KnowledgeLimitError('knowledge too large'))
})

/** Verifies that malformed persisted session state is not retried through the webhook. */
test('malformed session state remains deduplicated by the webhook', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  await withTempFile('zapcode-malformed-runtime-', 'session.json', '{broken', async (file) => {
    const store = new SessionStore({} as never, '/repo', file)
    /** Counts persisted-state reads before admission. */
    let reads = 0
    const harness = createRuntimeHarness({
      sessions: {
        getActiveRun: async () => {
          reads++
          return store.getActiveRun()
        },
      },
    })
    try {
      const app = createApp(webhookConfig, harness.runtime.handler)
      await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(500)
      await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(200, { duplicate: true })
      assert.equal(reads, 1)
    } finally {
      harness.restore()
    }
  })
})

/** Verifies that uncertain post-attempt work stays deduplicated at the webhook. */
test('post-attempt transport failure remains deduplicated by the webhook', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Counts prompt attempts. */
  let prompts = 0
  /** Counts exact inbox cancellations. */
  let cancellations = 0
  /** Counts session interruptions. */
  let interruptions = 0
  const harness = createRuntimeHarness({
    client: {
      message: { list: async () => ({ data: [] }) },
      session: {
        prompt: async () => { prompts++; throw new TypeError('fetch failed') },
        interrupt: async () => { interruptions++; return { interrupted: true } },
        inbox: { cancel: async () => { cancellations++ } },
      },
    },
  })
  try {
    const app = createApp(webhookConfig, harness.runtime.handler)
    await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(500)
    await request(app).post('/webhook').set('Webhook-Secret', 'secret').send(payload()).expect(200, { duplicate: true })
    assert.equal(prompts, 1)
    assert.equal(cancellations, 1)
    assert.equal(interruptions, 1)
  } finally {
    harness.restore()
  }
})
