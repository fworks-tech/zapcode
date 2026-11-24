/**
 * Session and response-selection regression tests.
 *
 * @remarks
 * Covers session validation, workdir/location mismatch, missing sessions, and
 * prevention of stale or failed assistant responses.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { extractReply } from '../src/opencode.js'
import { SAFE_PERMISSIONS } from '../src/permissions.js'
import { SessionStore } from '../src/session.js'

/** Verifies that reused sessions are validated and refreshed with current permissions. */
test('SessionStore validates and updates a reused session', async () => {
  /** Temporary directory for the session file. */
  const directory = await mkdtemp(path.join(tmpdir(), 'zapcode-session-reuse-'))
  /** Session file path. */
  const file = path.join(directory, 'session.json')
  /** Captures permission updates. */
  const updates: unknown[] = []
  await writeFile(file, JSON.stringify({ sessionID: 'session-1', workdir: '/repo' }))
  /** Mock client exposing the control calls used during reuse. */
  const client = {
    session: {
      get: async () => ({ id: 'session-1', location: { directory: '/repo' } }),
      update: async (input: unknown) => { updates.push(input) },
    },
  }
  try {
    const store = new SessionStore(client as never, '/repo', file)
    assert.equal(await store.ensure(), 'session-1')
    assert.deepEqual(updates, [{ sessionID: 'session-1', permissions: SAFE_PERMISSIONS }])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** Verifies that changing WORKDIR cannot silently orphan the saved session. */
test('SessionStore fails closed when the saved workdir differs', async () => {
  /** Temporary directory for the session file. */
  const directory = await mkdtemp(path.join(tmpdir(), 'zapcode-session-workdir-'))
  /** Session file path. */
  const file = path.join(directory, 'session.json')
  await writeFile(file, JSON.stringify({ sessionID: 'session-old', workdir: '/old', activeRun: { inboxID: 'msg-old' } }))
  /** Counts session creation calls. */
  let creates = 0
  const client = { session: { create: async () => { creates++; return { id: 'session-new' } } } }
  try {
    const store = new SessionStore(client as never, '/new', file)
    await assert.rejects(store.ensure(), /different WORKDIR/)
    assert.deepEqual(await store.getActiveRun(), { sessionID: 'session-old', inboxID: 'msg-old' })
    assert.equal(creates, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** Verifies that a moved server session cannot be silently replaced. */
test('SessionStore fails closed when the server session location differs', async () => {
  /** Temporary directory for the session file. */
  const directory = await mkdtemp(path.join(tmpdir(), 'zapcode-session-location-'))
  /** Session file path. */
  const file = path.join(directory, 'session.json')
  await writeFile(file, JSON.stringify({ sessionID: 'session-1', workdir: '/repo' }))
  /** Counts session creation calls. */
  let creates = 0
  const client = {
    session: {
      get: async () => ({ id: 'session-1', location: { directory: '/other' } }),
      create: async () => { creates++; return { id: 'session-new' } },
    },
  }
  try {
    const store = new SessionStore(client as never, '/repo', file)
    await assert.rejects(store.ensure(), /location does not match/)
    assert.equal(creates, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** Verifies that a missing server session is recreated instead of reused. */
test('SessionStore recreates a session after OpenCode returns 404', async () => {
  /** Temporary directory for the session file. */
  const directory = await mkdtemp(path.join(tmpdir(), 'zapcode-session-missing-'))
  /** Session file path. */
  const file = path.join(directory, 'session.json')
  await writeFile(file, JSON.stringify({ sessionID: 'missing', workdir: '/repo' }))
  /** Mock client whose get call returns 404 and create call returns a new ID. */
  const client = {
    session: {
      get: async () => { throw Object.assign(new Error('missing'), { name: 'SessionNotFoundError' }) },
      create: async () => ({ id: 'session-new' }),
    },
  }
  try {
    const store = new SessionStore(client as never, '/repo', file)
    assert.equal(await store.ensure(), 'session-new')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** Verifies that no new assistant response never falls back to older history. */
test('extractReply does not return an older assistant when no new response exists', () => {
  const response = {
    data: [
      { id: 'previous', type: 'assistant', content: [{ type: 'text', text: 'previous answer' }] },
      { id: 'older', type: 'assistant', content: [{ type: 'text', text: 'much older answer' }] },
    ],
  }
  assert.equal(extractReply(response, 'previous'), 'OpenCode finished without a text response.')
})

/** Verifies that assistant provider errors are surfaced independently. */
test('extractReply throws when the newest assistant failed', () => {
  assert.throws(() => extractReply({
    data: [{ id: 'failed-finish', type: 'assistant', finish: 'error', content: [] }],
  }), /assistant failed/)
  assert.throws(() => extractReply({
    data: [{ id: 'failed-error', type: 'assistant', error: { message: 'provider failed' }, content: [] }],
  }), /assistant failed/)
})
