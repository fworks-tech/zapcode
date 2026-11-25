/**
 * Permission bridge unit tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { PermissionBridge } from '../src/permissions.js'
import { deferred } from './helpers/runtime.js'
import { webhookConfig as config } from './helpers/webhook.js'

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
  await new Promise<void>((resolve) => setImmediate(resolve))
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
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(await permissions.decide('/yes perm-2') ?? '', /granted/)
  assert.equal(replies.length, 3)
})

/** Verifies that stream establishment precedes pending-request reconciliation. */
test('PermissionBridge establishes the stream before reconciling pending requests', async () => {
  /** Records the order of subscription and list operations. */
  const order: string[] = []
  /** Promise resolved by the mocked pending-request list call. */
  const listed = deferred<void>()
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
          listed.resolve()
          return { data: [] }
        },
      },
    },
  }
  /** Permission bridge started with the ordered mock client. */
  const permissions = new PermissionBridge(client as never, async () => undefined, config.allowedNumber)
  permissions.start()
  await listed.promise
  permissions.stop()
  assert.deepEqual(order, ['subscribe', 'list'])
})
