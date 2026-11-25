/**
 * Session persistence unit tests.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { SAFE_PERMISSIONS } from '../src/permission-policy.js'
import { SessionStore } from '../src/session.js'
import { withTempDirectory } from './helpers/temp.js'

test('SessionStore creates once and reuses the session after restart', async () => {
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
  await withTempDirectory('zapcode-session-', async (directory) => {
    const file = path.join(directory, 'session.json')
    /** First store instance creates the initial session. */
    const first = new SessionStore(client as never, '/repo', file)
    assert.equal(await first.ensure(), 'session-1')
    assert.equal(await new SessionStore(client as never, '/repo', file).ensure(), 'session-1')
    assert.equal(creates, 1)
    await first.reset()
    assert.equal(await first.ensure(), 'session-2')
  })
})
