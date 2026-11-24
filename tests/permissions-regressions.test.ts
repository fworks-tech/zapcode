/**
 * Permission-boundary regression tests.
 *
 * @remarks
 * Covers complete request display, reset-safe notifications, active-session
 * scope, saved approvals, policy-denied requests, and server reconciliation.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { PermissionBridge } from '../src/permissions.js'

/** Phone number allowed by the permission tests. */
const webhookConfig = { allowedNumber: '5511999999999' }

/** Verifies that long permission resources are sent without truncation. */
test('permission notifications include the complete long resource', async () => {
  /** Captures every WhatsApp chunk sent for the request. */
  const sent: string[] = []
  /** Resource whose destructive tail is far beyond the old 800-character cutoff. */
  const resource = `${'a'.repeat(1_000)} rm -rf /important`
  /** Mock client with no server-side pending requests. */
  const client = { permission: { request: { list: async () => ({ data: [] }) } } }
  /** Bridge scoped to one active session. */
  const permissions = new PermissionBridge(client as never, async (_to, text) => { sent.push(text) }, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({
    type: 'permission.asked',
    data: { id: 'perm-long', sessionID: 'session-1', action: 'shell', resources: [resource] },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(sent.join('').includes(resource))
})

/** Verifies that reset stops permission chunks that have not started sending. */
test('reset stops stale permission notification chunks', async () => {
  /** Resolver for the first blocked notification chunk. */
  let release!: () => void
  /** Promise controlling the first WhatsApp send. */
  const blocked = new Promise<void>((resolve) => { release = resolve })
  /** Resolver fired when the first notification send starts. */
  let markStarted!: () => void
  /** Promise that removes scheduling assumptions. */
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  /** Captures notification chunks. */
  const sent: string[] = []
  /** Resolver fired when reset rejects the server-side request. */
  let markRejected!: () => void
  /** Promise that ensures rejection happens before the blocked send resumes. */
  const rejected = new Promise<void>((resolve) => { markRejected = resolve })
  /** Pending request with a resource large enough for multiple chunks. */
  const pending = { id: 'perm-long', sessionID: 'session-1', action: 'shell', resources: ['x'.repeat(7_001)] }
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: {
      request: { list: async () => ({ data: [pending] }) },
      reply: async () => { markRejected() },
      saved: { list: async () => [], remove: async () => undefined },
    },
  }
  const permissions = new PermissionBridge(client as never, async (_to, text) => {
    sent.push(text)
    markStarted()
    await blocked
  }, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: pending })
  await started
  const clearing = permissions.clear('session-1')
  await rejected
  release()
  await clearing
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(sent.length, 1)
})

/** Verifies that missing project locations and other sessions are ignored. */
test('permission events fail closed for missing locations and other sessions', () => {
  /** Captures notification count. */
  let sent = 0
  /** Mock client with no server-side pending requests. */
  const client = { permission: { request: { list: async () => ({ data: [] }) } } }
  /** Bridge configured for one project and session. */
  const permissions = new PermissionBridge(client as never, async () => { sent++ }, webhookConfig.allowedNumber, '/repo')
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: { id: 'missing-location', sessionID: 'session-1', action: 'shell', resources: ['rm *'] } })
  permissions.handleEvent({ type: 'permission.asked', location: { directory: '/repo' }, data: { id: 'other-session', sessionID: 'session-2', action: 'shell', resources: ['rm *'] } })
  assert.equal(sent, 0)
})

/** Verifies that reconciliation resends a permission notification after delivery failure. */
test('permission reconciliation retries an undelivered notification', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Counts notification attempts. */
  let attempts = 0
  /** Server request that remains pending. */
  const pending = { id: 'perm-1', sessionID: 'session-1', action: 'shell', resources: ['git status'] }
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: { request: { list: async () => ({ data: [pending] }) }, saved: { list: async () => [], remove: async () => undefined } },
  }
  const permissions = new PermissionBridge(client as never, async () => {
    attempts++
    if (attempts === 1) throw new Error('temporary')
  }, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: pending })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await permissions.reconcile()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(attempts, 2)
})

/** Verifies that reset without a known session does not touch unrelated permissions. */
test('permission clear is a no-op when no session is known', async () => {
  /** Counts server list calls. */
  let listCalls = 0
  /** Counts server replies. */
  let replies = 0
  const client = {
    permission: {
      request: { list: async () => { listCalls++; return { data: [] } } },
      reply: async () => { replies++ },
    },
  }
  const permissions = new PermissionBridge(client as never, async () => undefined, webhookConfig.allowedNumber)
  await permissions.clear(undefined)
  assert.equal(listCalls, 0)
  assert.equal(replies, 0)
})

/** Verifies that durable project approvals are removed before prompts run. */
test('permission reconciliation removes saved project approvals', async () => {
  /** Captures removed saved-approval IDs. */
  const removed: string[] = []
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: {
      request: { list: async () => ({ data: [] }) },
      saved: {
        list: async () => [{ id: 'saved-1', projectID: 'project-1', action: 'shell', resource: 'git *', effect: 'allow', time: { created: 1 } }],
        remove: async ({ id }: { id: string }) => { removed.push(id) },
      },
    },
  }
  const permissions = new PermissionBridge(client as never, async () => undefined, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  await permissions.reconcile()
  assert.deepEqual(removed, ['saved-1'])
})

/** Verifies that requests denied by current policy are rejected without notification. */
test('permission events rejected by current policy never reach WhatsApp', async () => {
  /** Captures server replies. */
  const replies: unknown[] = []
  /** Captures notification count. */
  let notifications = 0
  const client = {
    permission: {
      reply: async (input: unknown) => { replies.push(input) },
    },
  }
  const permissions = new PermissionBridge(client as never, async () => { notifications++ }, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: { id: 'env-read', sessionID: 'session-1', action: 'read', resources: ['.env'] } })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(replies, [{ sessionID: 'session-1', requestID: 'env-read', decision: 'reject' }])
  assert.equal(notifications, 0)
})

/** Verifies that reconciliation removes locally tracked requests no longer pending. */
test('permission reconciliation removes stale local requests', async () => {
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: { request: { list: async () => ({ data: [] }) }, saved: { list: async () => [], remove: async () => undefined } },
  }
  const permissions = new PermissionBridge(client as never, async () => undefined, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: { id: 'stale', sessionID: 'session-1', action: 'shell', resources: ['git status'] } })
  await permissions.reconcile()
  assert.match(await permissions.decide('/yes stale') ?? '', /No pending permission/)
})

/** Verifies that reset rejects permissions that exist only on the server. */
test('permission clear reconciles and rejects server-only requests', async () => {
  /** Captures decisions sent to OpenCode. */
  const replies: unknown[] = []
  /** Mock client returning one pending request and recording rejection. */
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: {
      request: { list: async () => ({ data: [{ id: 'server-only', sessionID: 'session-1', action: 'shell', resources: ['rm *'] }] }) },
      reply: async (input: unknown) => { replies.push(input) },
      saved: { list: async () => [], remove: async () => undefined },
    },
  }
  /** Bridge with an empty local map but a non-empty server list. */
  const permissions = new PermissionBridge(client as never, async () => undefined, webhookConfig.allowedNumber, '/repo')
  permissions.setActiveSession('session-1')
  await permissions.clear('session-1')
  assert.deepEqual(replies, [{ sessionID: 'session-1', requestID: 'server-only', decision: 'reject' }])
})
