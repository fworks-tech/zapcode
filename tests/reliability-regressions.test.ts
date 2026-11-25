/**
 * Reliability, persistence, and knowledge-limit regression tests.
 *
 * @remarks
 * Covers concurrent webhook delivery, chunk retries, server-session removal,
 * active-run bookkeeping, and knowledge-base budgets.
 */

import assert from 'node:assert/strict'
import { readFile, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createApp } from '../src/app.js'
import { createMessageHandler } from '../src/handler.js'
import { KnowledgeLimitError, loadKnowledge } from '../src/knowledge.js'
import { SessionStore } from '../src/session.js'
import { deferred } from './helpers/runtime.js'
import { withTempDirectory, withTempFile } from './helpers/temp.js'
import { payload, webhookConfig } from './helpers/webhook.js'

/** Verifies that concurrent duplicate delivery receives an in-progress response. */
test('webhook returns 409 for a duplicate while the first delivery is pending', async () => {
  /** Promise controlling the first handler call. */
  const blocked = deferred<void>()
  /** Counts handler calls. */
  let calls = 0
  /** Promise that removes scheduling assumptions. */
  const started = deferred<void>()
  const app = createApp(webhookConfig, async () => { calls++; started.resolve(); await blocked.promise })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/webhook`
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Webhook-Secret': 'secret' },
    body: JSON.stringify(payload()),
  }
  const first = fetch(url, options)
  await started.promise
  const duplicate = await fetch(url, options)
  assert.equal(duplicate.status, 409)
  blocked.resolve()
  assert.equal((await first).status, 200)
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  assert.equal(calls, 1)
})

/** Verifies that response delivery retries a transient chunk failure. */
test('message handler retries a failed response chunk', async () => {
  /** Counts send attempts. */
  let attempts = 0
  const handler = createMessageHandler({
    prompt: async () => 'response',
    cancel: async () => undefined,
    reset: async () => undefined,
    decidePermission: async () => null,
    send: async () => {
      attempts++
      if (attempts === 1) throw new Error('temporary')
    },
    allowedNumber: webhookConfig.allowedNumber,
  })
  await handler(webhookConfig.allowedNumber, 'question')
  assert.equal(attempts, 2)
})

/** Verifies that reset removes the server session before deleting local state. */
test('SessionStore reset removes the server conversation', async () => {
  /** Captures removed session IDs. */
  const removed: string[] = []
  const client = { session: { remove: async ({ sessionID }: { sessionID: string }) => { removed.push(sessionID) } } }
  await withTempFile('zapcode-session-reset-', 'session.json', JSON.stringify({ sessionID: 'session-1', workdir: '/repo' }), async (file) => {
    const store = new SessionStore(client as never, '/repo', file)
    await store.reset()
    assert.deepEqual(removed, ['session-1'])
    assert.equal(await store.reset(), undefined)
  })
})

/** Verifies that server removal failure preserves the local session pointer. */
test('SessionStore reset preserves local state when server removal fails', async () => {
  const client = { session: { remove: async () => { throw new Error('remove failed') } } }
  await withTempFile('zapcode-session-reset-failure-', 'session.json', JSON.stringify({ sessionID: 'session-1', workdir: '/repo' }), async (file) => {
    const store = new SessionStore(client as never, '/repo', file)
    await assert.rejects(store.reset(), /remove failed/)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).sessionID, 'session-1')
  })
})

/** Verifies that a missing server session does not prevent local cleanup. */
test('SessionStore reset treats a missing server session as already removed', async () => {
  const client = { session: { remove: async () => { throw Object.assign(new Error('missing'), { name: 'SessionNotFoundError' }) } } }
  await withTempFile('zapcode-session-reset-missing-', 'session.json', JSON.stringify({ sessionID: 'missing', workdir: '/repo' }), async (file) => {
    const store = new SessionStore(client as never, '/repo', file)
    await store.reset()
    await assert.rejects(readFile(file, 'utf8'), /ENOENT|no such file/i)
  })
})

/** Verifies active-run persistence and cleanup in the session file. */
test('SessionStore persists and clears active inbox bookkeeping', async () => {
  await withTempFile('zapcode-active-run-', 'session.json', JSON.stringify({ sessionID: 'session-1', workdir: '/repo' }), async (file) => {
    /** Store used without server calls for marker-only operations. */
    const store = new SessionStore({} as never, '/repo', file)
    await store.markActive('msg-1')
    assert.deepEqual(await store.getActiveRun(), { sessionID: 'session-1', inboxID: 'msg-1' })
    await store.clearActive('different')
    assert.deepEqual(await store.getActiveRun(), { sessionID: 'session-1', inboxID: 'msg-1' })
    await store.clearActive('msg-1')
    assert.equal(await store.getActiveRun(), undefined)
  })
})

/** Verifies that twenty knowledge files are accepted. */
test('knowledge loader accepts twenty Markdown files', async () => {
  await withTempDirectory('zapcode-twenty-knowledge-', async (directory) => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeFile(path.join(directory, `${index}.md`), 'x')))
    assert.equal((await loadKnowledge(directory)).length, 20)
  })
})

/** Verifies that a twenty-first knowledge file is rejected. */
test('knowledge loader rejects twenty-one Markdown files', async () => {
  await withTempDirectory('zapcode-twenty-one-knowledge-', async (directory) => {
    await Promise.all(Array.from({ length: 21 }, (_, index) => writeFile(path.join(directory, `${index}.md`), 'x')))
    await assert.rejects(loadKnowledge(directory), (error) => error instanceof KnowledgeLimitError && /more than 20 Markdown files/.test(error.message))
  })
})

/** Verifies that oversized files are rejected before their content is loaded. */
test('knowledge loader rejects a large sparse file', async () => {
  await withTempDirectory('zapcode-sparse-knowledge-', async (directory) => {
    /** Large sparse Markdown file. */
    const file = path.join(directory, 'large.md')
    await writeFile(file, '')
    await truncate(file, 1_000_000)
    /** Counts content reads after size preflight. */
    let reads = 0
    await assert.rejects(loadKnowledge(directory, async () => { reads++; return '' }), /exceeds 24000 characters/)
    assert.equal(reads, 0)
  })
})

/** Verifies that aggregate byte size is rejected before any content read. */
test('knowledge loader rejects individually valid files whose combined size exceeds the budget', async () => {
  await withTempDirectory('zapcode-aggregate-knowledge-', async (directory) => {
    /** First individually valid sparse file. */
    const first = path.join(directory, 'a.md')
    /** Second individually valid sparse file. */
    const second = path.join(directory, 'b.md')
    await writeFile(first, '')
    await writeFile(second, '')
    await Promise.all([truncate(first, 15_000), truncate(second, 15_000)])
    /** Counts content reads after size preflight. */
    let reads = 0
    await assert.rejects(loadKnowledge(directory, async () => { reads++; return '' }), /exceeds 24000 characters/)
    assert.equal(reads, 0)
  })
})

/** Verifies that oversized knowledge bases fail with a clear error. */
test('knowledge loader enforces its total character budget', async () => {
  await withTempDirectory('zapcode-large-knowledge-', async (directory) => {
    await writeFile(path.join(directory, 'large.md'), 'x'.repeat(24_001))
    await assert.rejects(loadKnowledge(directory), (error) => error instanceof KnowledgeLimitError && /exceeds 24000 characters/.test(error.message))
  })
})
