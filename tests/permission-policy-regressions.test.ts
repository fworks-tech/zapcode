/**
 * Permission delivery and reconciliation regression tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { PermissionBridge } from '../src/permissions.js'
import { deferred } from './helpers/runtime.js'
import { webhookConfig } from './helpers/webhook.js'

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

/** Verifies that a missing saved rule cannot hide another cleanup failure. */
test('permission reconciliation fails when saved-approval cleanup has a mixed failure', async () => {
  /** Captures every removal attempt. */
  const removed: string[] = []
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: {
      request: { list: async () => ({ data: [] }) },
      saved: {
        list: async () => [{ id: 'missing' }, { id: 'failed' }],
        remove: async ({ id }: { id: string }) => {
          removed.push(id)
          if (id === 'missing') throw Object.assign(new Error('missing'), { name: 'NotFoundError' })
          throw new Error('temporary')
        },
      },
    },
  }
  const permissions = new PermissionBridge(client as never, async () => undefined, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  await assert.rejects(permissions.reconcile(), /temporary/)
  assert.deepEqual(removed.sort(), ['failed', 'missing'])
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

/** Verifies that an unavailable server list never erases locally known requests. */
test('permission reconciliation preserves local requests when the server list returns 404', async () => {
  /** Captures server decisions. */
  const replies: unknown[] = []
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: {
      request: { list: async () => { throw Object.assign(new Error('missing'), { name: 'NotFoundError' }) } },
      reply: async (input: unknown) => { replies.push(input) },
      saved: { list: async () => [], remove: async () => undefined },
    },
  }
  const permissions = new PermissionBridge(client as never, async () => undefined, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: { id: 'local', sessionID: 'session-1', action: 'shell', resources: ['git status'] } })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await permissions.reconcile()
  assert.match(await permissions.decide('/yes local') ?? '', /granted once/)
  assert.deepEqual(replies, [{ sessionID: 'session-1', requestID: 'local', decision: 'once' }])
})

/** Verifies that permission events arriving during cleanup are rejected before reset returns. */
test('permission clear rejects late events without notifying the owner', async () => {
  /** Promise resolved when server reconciliation starts. */
  const listStarted = deferred<void>()
  /** Promise controlling the server-list snapshot. */
  const releaseList = deferred<void>()
  /** Promise resolved when the late rejection reaches the server. */
  const replyStarted = deferred<void>()
  /** Promise controlling the late server rejection. */
  const releaseReply = deferred<void>()
  /** Captures server decisions. */
  const replies: unknown[] = []
  /** Counts owner notifications. */
  let notifications = 0
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: {
      request: {
        list: async () => {
          listStarted.resolve()
          await releaseList.promise
          return { data: [] }
        },
      },
      reply: async (input: unknown) => {
        replies.push(input)
        replyStarted.resolve()
        await releaseReply.promise
      },
      saved: { list: async () => [], remove: async () => undefined },
    },
  }
  const permissions = new PermissionBridge(client as never, async () => { notifications++ }, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  /** Records whether cleanup returned before the blocked reply finished. */
  let cleared = false
  const clearing = permissions.clear('session-1').then(() => { cleared = true })
  await listStarted.promise
  permissions.handleEvent({ type: 'permission.asked', data: { id: 'late', sessionID: 'session-1', action: 'shell', resources: ['git status'] } })
  releaseList.resolve()
  await replyStarted.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(cleared, false)
  releaseReply.resolve()
  await clearing
  assert.deepEqual(replies, [{ sessionID: 'session-1', requestID: 'late', decision: 'reject' }])
  assert.equal(notifications, 0)
})

/** Verifies that reset fails when a late permission cannot be rejected. */
test('permission clear fails when a late event rejection exhausts retries', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Promise resolved when server reconciliation starts. */
  const listStarted = deferred<void>()
  /** Promise controlling the server-list snapshot. */
  const releaseList = deferred<void>()
  /** Counts late rejection attempts. */
  let attempts = 0
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: {
      request: {
        list: async () => {
          listStarted.resolve()
          await releaseList.promise
          return { data: [] }
        },
      },
      reply: async () => { attempts++; throw new Error('temporary') },
      saved: { list: async () => [], remove: async () => undefined },
    },
  }
  const permissions = new PermissionBridge(client as never, async () => undefined, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  const clearing = permissions.clear('session-1')
  await listStarted.promise
  permissions.handleEvent({ type: 'permission.asked', data: { id: 'late-failure', sessionID: 'session-1', action: 'shell', resources: ['git status'] } })
  releaseList.resolve()
  await assert.rejects(clearing, /temporary/)
  assert.equal(attempts, 3)
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
