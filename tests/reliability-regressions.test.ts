/**
 * Reliability, persistence, and knowledge-limit regression tests.
 *
 * @remarks
 * Covers concurrent webhook delivery, chunk retries, server-session removal,
 * active-run bookkeeping, and knowledge-base budgets.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from '../src/app.js'
import { createMessageHandler } from '../src/handler.js'
import { loadKnowledge } from '../src/knowledge.js'
import { SessionStore } from '../src/session.js'

/** Webhook settings shared by the HTTP tests. */
const webhookConfig = {
  webhookSecret: 'secret',
  allowedNumber: '5511999999999',
}

/** Builds a valid direct-message payload. */
function payload() {
  return {
    event: 'messages.upsert',
    data: {
      key: { id: 'message-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      message: { conversation: 'Hello' },
    },
  }
}

/** Verifies that concurrent duplicate delivery receives an in-progress response. */
test('webhook returns 409 for a duplicate while the first delivery is pending', async () => {
  /** Resolver for the blocked handler. */
  let release!: () => void
  /** Promise controlling the first handler call. */
  const blocked = new Promise<void>((resolve) => { release = resolve })
  /** Counts handler calls. */
  let calls = 0
  /** Resolver fired when the first handler call starts. */
  let markStarted!: () => void
  /** Promise that removes scheduling assumptions from the test. */
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const app = createApp(webhookConfig, async () => { calls++; markStarted(); await blocked })
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
  await started
  const duplicate = await fetch(url, options)
  assert.equal(duplicate.status, 409)
  release()
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
  /** Temporary directory for the session file. */
  const directory = await mkdtemp(path.join(tmpdir(), 'zapcode-session-reset-'))
  /** Session file path. */
  const file = path.join(directory, 'session.json')
  await writeFile(file, JSON.stringify({ sessionID: 'session-1', workdir: '/repo' }))
  /** Captures removed session IDs. */
  const removed: string[] = []
  const client = { session: { remove: async ({ sessionID }: { sessionID: string }) => { removed.push(sessionID) } } }
  try {
    const store = new SessionStore(client as never, '/repo', file)
    await store.reset()
    assert.deepEqual(removed, ['session-1'])
    assert.equal(await store.reset(), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** Verifies that server removal failure preserves the local session pointer. */
test('SessionStore reset preserves local state when server removal fails', async () => {
  /** Temporary directory for the session file. */
  const directory = await mkdtemp(path.join(tmpdir(), 'zapcode-session-reset-failure-'))
  /** Session file path. */
  const file = path.join(directory, 'session.json')
  await writeFile(file, JSON.stringify({ sessionID: 'session-1', workdir: '/repo' }))
  const client = { session: { remove: async () => { throw new Error('remove failed') } } }
  try {
    const store = new SessionStore(client as never, '/repo', file)
    await assert.rejects(store.reset(), /remove failed/)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).sessionID, 'session-1')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** Verifies that a missing server session does not prevent local cleanup. */
test('SessionStore reset treats a missing server session as already removed', async () => {
  /** Temporary directory for the session file. */
  const directory = await mkdtemp(path.join(tmpdir(), 'zapcode-session-reset-missing-'))
  /** Session file path. */
  const file = path.join(directory, 'session.json')
  await writeFile(file, JSON.stringify({ sessionID: 'missing', workdir: '/repo' }))
  const client = { session: { remove: async () => { throw Object.assign(new Error('missing'), { name: 'SessionNotFoundError' }) } } }
  try {
    const store = new SessionStore(client as never, '/repo', file)
    await store.reset()
    await assert.rejects(readFile(file, 'utf8'), /ENOENT|no such file/i)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** Verifies active-run persistence and cleanup in the session file. */
test('SessionStore persists and clears active inbox bookkeeping', async () => {
  /** Temporary directory for the session file. */
  const directory = await mkdtemp(path.join(tmpdir(), 'zapcode-active-run-'))
  /** Session file path. */
  const file = path.join(directory, 'session.json')
  await writeFile(file, JSON.stringify({ sessionID: 'session-1', workdir: '/repo' }))
  /** Store used without server calls for marker-only operations. */
  const store = new SessionStore({} as never, '/repo', file)
  try {
    await store.markActive('msg-1')
    assert.deepEqual(await store.getActiveRun(), { sessionID: 'session-1', inboxID: 'msg-1' })
    await store.clearActive('different')
    assert.deepEqual(await store.getActiveRun(), { sessionID: 'session-1', inboxID: 'msg-1' })
    await store.clearActive('msg-1')
    assert.equal(await store.getActiveRun(), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** Verifies that oversized knowledge bases fail with a clear error. */
test('knowledge loader enforces its total character budget', async () => {
  /** Temporary knowledge directory. */
  const directory = await mkdtemp(path.join(tmpdir(), 'zapcode-large-knowledge-'))
  try {
    await writeFile(path.join(directory, 'large.md'), 'x'.repeat(24_001))
    await assert.rejects(loadKnowledge(directory), /exceeds 24000 characters/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
