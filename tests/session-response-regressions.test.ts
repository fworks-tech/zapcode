/**
 * Session and response-selection regression tests.
 *
 * @remarks
 * Covers session validation, workdir/location mismatch, missing sessions, and
 * prevention of stale or failed assistant responses.
 */

import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { extractReply } from '../src/opencode.js'
import { SAFE_PERMISSIONS } from '../src/permission-policy.js'
import { SessionConfigurationError, SessionStore } from '../src/session.js'
import { withTempDirectory, withTempFile } from './helpers/temp.js'

/** Verifies that reused sessions are validated and refreshed with current permissions. */
test('SessionStore validates and updates a reused session', async () => {
  /** Captures permission updates. */
  const updates: unknown[] = []
  /** Mock client exposing the control calls used during reuse. */
  const client = {
    session: {
      get: async () => ({ id: 'session-1', location: { directory: '/repo' } }),
      update: async (input: unknown) => { updates.push(input) },
    },
  }
  await withTempFile('zapcode-session-reuse-', 'session.json', JSON.stringify({ sessionID: 'session-1', workdir: '/repo' }), async (file) => {
    const store = new SessionStore(client as never, '/repo', file)
    assert.equal(await store.ensure(), 'session-1')
    assert.deepEqual(updates, [{ sessionID: 'session-1', permissions: SAFE_PERMISSIONS }])
  })
})

/** Verifies that changing WORKDIR cannot silently orphan the saved session. */
test('SessionStore fails closed when the saved workdir differs', async () => {
  /** Counts session creation calls. */
  let creates = 0
  const client = { session: { create: async () => { creates++; return { id: 'session-new' } } } }
  await withTempFile('zapcode-session-workdir-', 'session.json', JSON.stringify({ sessionID: 'session-old', workdir: '/old', activeRun: { inboxID: 'msg-old' } }), async (file) => {
    const store = new SessionStore(client as never, '/new', file)
    await assert.rejects(store.ensure(), (error) => error instanceof SessionConfigurationError && /different WORKDIR/.test(error.message))
    assert.deepEqual(await store.getActiveRun(), { sessionID: 'session-old', inboxID: 'msg-old' })
    assert.equal(creates, 0)
  })
})

/** Verifies that a moved server session cannot be silently replaced. */
test('SessionStore fails closed when the server session location differs', async () => {
  /** Counts session creation calls. */
  let creates = 0
  const client = {
    session: {
      get: async () => ({ id: 'session-1', location: { directory: '/other' } }),
      create: async () => { creates++; return { id: 'session-new' } },
    },
  }
  await withTempFile('zapcode-session-location-', 'session.json', JSON.stringify({ sessionID: 'session-1', workdir: '/repo' }), async (file) => {
    const store = new SessionStore(client as never, '/repo', file)
    await assert.rejects(store.ensure(), (error) => error instanceof SessionConfigurationError && /location does not match/.test(error.message))
    assert.equal(creates, 0)
  })
})

/** Verifies that a missing server session is recreated instead of reused. */
test('SessionStore recreates a session after OpenCode returns 404', async () => {
  /** Mock client whose get call returns 404 and create call returns a new ID. */
  const client = {
    session: {
      get: async () => { throw Object.assign(new Error('missing'), { name: 'SessionNotFoundError' }) },
      create: async () => ({ id: 'session-new' }),
    },
  }
  await withTempFile('zapcode-session-missing-', 'session.json', JSON.stringify({ sessionID: 'missing', workdir: '/repo' }), async (file) => {
    const store = new SessionStore(client as never, '/repo', file)
    assert.equal(await store.ensure(), 'session-new')
  })
})

/** Verifies that malformed session JSON fails closed without creating a session. */
test('SessionStore rejects malformed JSON instead of overwriting it', async () => {
  /** Counts session creation calls. */
  let creates = 0
  const client = { session: { create: async () => { creates++; return { id: 'session-new' } } } }
  await withTempFile('zapcode-session-invalid-json-', 'session.json', '{broken', async (file) => {
    const store = new SessionStore(client as never, '/repo', file)
    await assert.rejects(store.ensure(), /Invalid JSON/)
    assert.equal(creates, 0)
    assert.equal(await readFile(file, 'utf8'), '{broken')
  })
})

/** Verifies that invalid session shapes fail closed. */
test('SessionStore rejects an invalid session shape', async () => {
  await withTempFile('zapcode-session-invalid-shape-', 'session.json', JSON.stringify({ sessionID: 42, workdir: '/repo' }), async (file) => {
    const store = new SessionStore({} as never, '/repo', file)
    await assert.rejects(store.ensure(), /Invalid data\/session.json shape/)
  })
})

/** Verifies that malformed active-run bookkeeping fails closed. */
test('SessionStore rejects invalid activeRun state', async () => {
  await withTempFile('zapcode-session-invalid-run-', 'session.json', JSON.stringify({ sessionID: 'session-1', workdir: '/repo', activeRun: { inboxID: 42 } }), async (file) => {
    const store = new SessionStore({} as never, '/repo', file)
    await assert.rejects(store.ensure(), /Invalid activeRun/)
  })
})

/** Verifies that concurrent marker cleanup never shares a temporary file. */
test('SessionStore clearActive is safe under concurrent calls', async () => {
  await withTempFile('zapcode-session-concurrent-', 'session.json', JSON.stringify({ sessionID: 'session-1', workdir: '/repo', activeRun: { inboxID: 'msg-1' } }), async (file) => {
    const store = new SessionStore({ session: { remove: async () => undefined } } as never, '/repo', file)
    const writes = Array.from({ length: 50 }, () => store.clearActive('msg-1'))
    const resetting = store.reset()
    await Promise.all([...writes, resetting])
    await assert.rejects(readFile(file, 'utf8'), /ENOENT|no such file/i)
  })
})

/** Verifies that conflicting marker updates cannot lose a newer active run. */
test('SessionStore serializes clearActive and markActive read-modify-write operations', async () => {
  await withTempFile('zapcode-session-conflicting-', 'session.json', JSON.stringify({ sessionID: 'session-1', workdir: '/repo', activeRun: { inboxID: 'msg-old' } }), async (file) => {
    const store = new SessionStore({} as never, '/repo', file)
    const clearing = store.clearActive('msg-old')
    const marking = store.markActive('msg-new')
    await Promise.all([clearing, marking])
    assert.deepEqual(await store.getActiveRun(), { sessionID: 'session-1', inboxID: 'msg-new' })
  })
})

/** Verifies that a failed pointer write removes the new server session. */
test('SessionStore removes a newly created session when persistence fails', async () => {
  await withTempDirectory('zapcode-session-write-failure-', async (directory) => {
    const file = path.join(directory, 'session.json')
    /** Captures removed session IDs. */
    const removed: string[] = []
    const client = {
      session: {
        create: async () => {
          await mkdir(file)
          return { id: 'session-new' }
        },
        remove: async ({ sessionID }: { sessionID: string }) => { removed.push(sessionID) },
      },
    }
    const store = new SessionStore(client as never, '/repo', file)
    await assert.rejects(store.ensure())
    assert.deepEqual(removed, ['session-new'])
  })
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
