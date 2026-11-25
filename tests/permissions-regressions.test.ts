/**
 * Permission delivery and reconciliation regression tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { PermissionBridge } from '../src/permissions.js'
import { deferred } from './helpers/runtime.js'
import { webhookConfig } from './helpers/webhook.js'

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
  /** Promise controlling the first WhatsApp send. */
  const blocked = deferred<void>()
  /** Promise that removes scheduling assumptions. */
  const started = deferred<void>()
  /** Captures notification chunks. */
  const sent: string[] = []
  /** Promise that ensures rejection happens before the blocked send resumes. */
  const rejected = deferred<void>()
  /** Pending request with a resource large enough for multiple chunks. */
  const pending = { id: 'perm-long', sessionID: 'session-1', action: 'shell', resources: ['x'.repeat(7_001)] }
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: {
      request: { list: async () => ({ data: [pending] }) },
      reply: async () => { rejected.resolve() },
      saved: { list: async () => [], remove: async () => undefined },
    },
  }
  const permissions = new PermissionBridge(client as never, async (_to, text) => {
    sent.push(text)
    started.resolve()
    await blocked.promise
  }, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: pending })
  await started.promise
  const clearing = permissions.clear('session-1')
  await rejected.promise
  blocked.resolve()
  await clearing
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(sent.length, 1)
})

/** Verifies that approval waits until every notification chunk is delivered. */
test('permission approval waits for the complete notification', async () => {
  /** Captures notification chunks. */
  const sent: string[] = []
  /** Captures server decisions. */
  const replies: unknown[] = []
  /** Promise controlling the final instruction chunk. */
  const blockedFinal = deferred<void>()
  /** Promise that removes scheduling assumptions. */
  const firstStarted = deferred<void>()
  /** Promise resolved when the final chunk reaches its blocked send. */
  const finalStarted = deferred<void>()
  /** Promise resolved after the final chunk is delivered. */
  const completed = deferred<void>()
  const pending = { id: 'perm-full', sessionID: 'session-1', action: 'shell', resources: ['x'.repeat(7_001)] }
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: {
      reply: async (input: unknown) => { replies.push(input) },
      request: { list: async () => ({ data: [] }) },
      saved: { list: async () => [], remove: async () => undefined },
    },
  }
  const permissions = new PermissionBridge(client as never, async (_to, text) => {
    sent.push(text)
    if (sent.length === 1) firstStarted.resolve()
    if (text.includes('/yes perm-full')) {
      finalStarted.resolve()
      await blockedFinal.promise
      completed.resolve()
    }
  }, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: pending })
  await firstStarted.promise
  assert.match(await permissions.decide('/yes perm-full') ?? '', /still being sent/)
  assert.deepEqual(replies, [])
  await finalStarted.promise
  assert.match(await permissions.decide('/yes perm-full') ?? '', /still being sent/)
  assert.deepEqual(replies, [])
  blockedFinal.resolve()
  await completed.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(await permissions.decide('/yes perm-full') ?? '', /granted once/)
  assert.deepEqual(replies, [{ sessionID: 'session-1', requestID: 'perm-full', decision: 'once' }])
})

/** Verifies that an asked event plus reconciliation sends one notification. */
test('permission reconciliation does not duplicate an in-flight notification', async () => {
  /** Captures notification count. */
  let notifications = 0
  /** Promise controlling notification completion. */
  const blocked = deferred<void>()
  /** Promise that removes scheduling assumptions. */
  const started = deferred<void>()
  const pending = { id: 'perm-1', sessionID: 'session-1', action: 'shell', resources: ['git status'] }
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: {
      request: { list: async () => ({ data: [pending] }) },
      saved: { list: async () => [], remove: async () => undefined },
    },
  }
  const permissions = new PermissionBridge(client as never, async () => {
    notifications++
    started.resolve()
    await blocked.promise
  }, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: pending })
  await started.promise
  await permissions.reconcile()
  assert.equal(notifications, 1)
  blocked.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
})

/** Verifies that automatic policy denials retry transient server failures. */
test('permission policy denial retries a transient rejection failure', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Counts rejection attempts. */
  let attempts = 0
  /** Promise resolved by the second attempt. */
  const retried = deferred<void>()
  const client = {
    permission: {
      reply: async () => {
        attempts++
        if (attempts === 1) throw new Error('temporary')
        retried.resolve()
      },
    },
  }
  const permissions = new PermissionBridge(client as never, async () => undefined, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: { id: 'env-read', sessionID: 'session-1', action: 'read', resources: ['.env'] } })
  await retried.promise
  assert.equal(attempts, 2)
})

/** Builds a permission whose final notification chunk fails until reconciliation. */
function createFailedDeliveryHarness() {
  /** Captures every notification chunk. */
  const sent: string[] = []
  /** Captures server decisions. */
  const replies: unknown[] = []
  /** Controls whether the final chunk keeps failing. */
  let failing = true
  /** Counts final-chunk attempts during the failed delivery. */
  let finalAttempts = 0
  /** First chunk used to prove reconciliation redelivers the whole request. */
  let firstChunk = ''
  /** Promise resolved after internal retries are exhausted. */
  const exhausted = deferred<void>()
  /** Promise resolved after reconciliation delivers the final chunk. */
  const redelivered = deferred<void>()
  const pending = { id: 'perm-retry', sessionID: 'session-1', action: 'shell', resources: ['x'.repeat(7_001)] }
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: {
      request: { list: async () => ({ data: [pending] }) },
      reply: async (input: unknown) => { replies.push(input) },
      saved: { list: async () => [], remove: async () => undefined },
    },
  }
  const permissions = new PermissionBridge(client as never, async (_to, text) => {
    sent.push(text)
    if (!firstChunk) firstChunk = text
    if (!text.includes('/yes perm-retry')) return
    if (failing) {
      finalAttempts++
      if (finalAttempts === 3) exhausted.resolve()
      throw new Error('temporary')
    }
    redelivered.resolve()
  }, webhookConfig.allowedNumber)
  return {
    sent,
    replies,
    exhausted,
    redelivered,
    permissions,
    pending,
    firstChunk: () => firstChunk,
    allowDelivery: () => { failing = false },
  }
}

/** Verifies that a failed later chunk stays gated until reconciliation redelivers it. */
test('failed multi-chunk delivery cannot be approved before full redelivery', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  const harness = createFailedDeliveryHarness()
  harness.permissions.setActiveSession('session-1')
  harness.permissions.handleEvent({ type: 'permission.asked', data: harness.pending })
  await harness.exhausted.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(await harness.permissions.decide('/yes perm-retry') ?? '', /still being sent/)
  assert.deepEqual(harness.replies, [])

  harness.allowDelivery()
  await harness.permissions.reconcile()
  await harness.redelivered.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(harness.sent.filter((text) => text === harness.firstChunk()).length, 2)
  assert.match(await harness.permissions.decide('/yes perm-retry') ?? '', /granted once/)
  assert.deepEqual(harness.replies, [{ sessionID: 'session-1', requestID: 'perm-retry', decision: 'once' }])
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
  /** Controls whether delivery keeps failing. */
  let failing = true
  /** Promise resolved by the third failed attempt. */
  const exhausted = deferred<void>()
  /** Promise resolved by the fourth attempt. */
  const reconciled = deferred<void>()
  /** Server request that remains pending. */
  const pending = { id: 'perm-1', sessionID: 'session-1', action: 'shell', resources: ['git status'] }
  const client = {
    session: { get: async () => ({ id: 'session-1', projectID: 'project-1' }) },
    permission: { request: { list: async () => ({ data: [pending] }) }, saved: { list: async () => [], remove: async () => undefined } },
  }
  const permissions = new PermissionBridge(client as never, async () => {
    attempts++
    if (failing) {
      if (attempts === 3) exhausted.resolve()
      throw new Error('temporary')
    }
    reconciled.resolve()
  }, webhookConfig.allowedNumber)
  permissions.setActiveSession('session-1')
  permissions.handleEvent({ type: 'permission.asked', data: pending })
  await exhausted.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  failing = false
  await permissions.reconcile()
  await reconciled.promise
  assert.equal(attempts, 4)
})
