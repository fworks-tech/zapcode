/**
 * Runtime lifecycle tests for reset and cancellation races.
 *
 * @remarks
 * These tests defer session creation to reproduce `/reset` arriving before
 * prompt admission, then verify stale work cannot run or report success.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimeHarness, deferred, webhookConfig } from './helpers/runtime.js'

/** Runtime harness callbacks used by reset race tests. */
interface ResetHarnessCallbacks {
  /** Called if stale work reaches prompt admission. */
  onPrompt?: () => void
  /** Called for each inbox cancellation attempt. */
  onCancel?: (input: unknown) => void
  /** Called when persisted session cleanup runs. */
  onReset?: () => void
  /** Called when permission cleanup runs. */
  onPermissionsClear?: () => void
}

/** Builds the shared paused-session reset harness. */
function createResetHarness(
  session: { promise: Promise<string> },
  callbacks: ResetHarnessCallbacks = {},
): ReturnType<typeof createRuntimeHarness> {
  return createRuntimeHarness({
    client: {
      session: {
        prompt: async () => { callbacks.onPrompt?.(); return { id: 'msg-old' } },
        inbox: { cancel: async (input: unknown) => { callbacks.onCancel?.(input) } },
        interrupt: async () => ({ interrupted: true }),
      },
    },
    sessions: {
      ensure: () => session.promise,
      reset: async () => { callbacks.onReset?.() },
    },
    permissions: { clear: async () => { callbacks.onPermissionsClear?.() } },
  })
}

/** Runs reset while session creation is paused, then releases the stale setup. */
async function resetDuringSessionCreation(
  harness: ReturnType<typeof createRuntimeHarness>,
  session: { promise: Promise<string>; resolve: (value: string) => void },
): Promise<void> {
  const pending = harness.runtime.handler(webhookConfig.allowedNumber, 'old task')
  await new Promise<void>((resolve) => setImmediate(resolve))
  const resetting = harness.runtime.handler(webhookConfig.allowedNumber, '/reset')
  await new Promise<void>((resolve) => setImmediate(resolve))
  session.resolve('session-old')
  await Promise.all([pending, resetting])
}

/** Verifies that reset during session creation prevents old prompt admission. */
test('reset before sessions.ensure prevents old admission and cleans up afterwards', async () => {
  /** Deferred session ID used to pause `sessions.ensure()`. */
  const session = deferred<string>()
  /** Captures OpenCode inbox cancellation requests. */
  const cancelled: unknown[] = []
  /** Records whether the stale prompt reached OpenCode. */
  let admitted = false
  /** Records whether persisted session cleanup ran. */
  let reset = false
  /** Records whether pending permissions were cleared. */
  let permissionsCleared = false
  const harness = createResetHarness(session, {
    onPrompt: () => { admitted = true },
    onCancel: (input) => { cancelled.push(input) },
    onReset: () => { reset = true },
    onPermissionsClear: () => { permissionsCleared = true },
  })
  try {
    await resetDuringSessionCreation(harness, session)

    assert.equal(admitted, false)
    assert.equal(reset, true)
    assert.equal(permissionsCleared, true)
    assert.ok(cancelled.length >= 1)
    assert.ok(cancelled.every((item) => (item as { sessionID: string }).sessionID === 'session-old'))
    assert.match((cancelled[0] as { inboxID: string }).inboxID, /^msg_/)
    assert.deepEqual(harness.sent, ['Saved session cleared. Your next message starts with a clean context.'])
  } finally {
    harness.restore()
  }
})

/** Verifies that permission events are suppressed while server session removal is pending. */
test('/reset deactivates permission events before server session removal', async () => {
  /** Promise resolved when server session removal starts. */
  const resetStarted = deferred<void>()
  /** Promise controlling server session removal. */
  const releaseReset = deferred<void>()
  /** Permission session currently selected by the bridge. */
  let activeSession: string | undefined
  /** Captures stale approval notifications. */
  const notifications: string[] = []
  const permissions = {
    clear: async () => undefined,
    decide: async () => null,
    setActiveSession: (sessionID: string | undefined) => { activeSession = sessionID },
    reconcile: async () => undefined,
    receiveAsked: () => { if (activeSession) notifications.push('late') },
  }
  const harness = createRuntimeHarness({
    sessions: {
      reset: async () => {
        resetStarted.resolve()
        await releaseReset.promise
      },
    },
    permissions,
  })
  try {
    const resetting = harness.runtime.handler(webhookConfig.allowedNumber, '/reset')
    await resetStarted.promise
    permissions.receiveAsked()
    assert.deepEqual(notifications, [])
    releaseReset.resolve()
    await resetting
    assert.equal(activeSession, undefined)
  } finally {
    harness.restore()
  }
})

/** Verifies that failed server removal restores permission routing. */
test('/reset restores the permission session when server removal fails', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Permission session currently selected by the bridge. */
  let activeSession: string | undefined
  /** Counts permission reconciliation attempts after failure. */
  let reconciles = 0
  const permissions = {
    clear: async () => undefined,
    decide: async () => null,
    setActiveSession: (sessionID: string | undefined) => { activeSession = sessionID },
    reconcile: async () => { reconciles++ },
  }
  const harness = createRuntimeHarness({
    sessions: { reset: async () => { throw new Error('remove failed') } },
    permissions,
  })
  try {
    await harness.runtime.handler(webhookConfig.allowedNumber, '/reset')
    assert.equal(activeSession, 'session-1')
    assert.equal(reconciles, 1)
    assert.deepEqual(harness.sent, ['I could not reset the session. Try again.'])
  } finally {
    harness.restore()
  }
})

/** Verifies that reset does not report success when cancellation fails. */
test('reset does not confirm success when cancellation fails', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Deferred session ID used to pause `sessions.ensure()`. */
  const session = deferred<string>()
  /** Records whether persisted session cleanup ran. */
  let reset = false
  /** Records whether pending permissions were cleared. */
  let permissionsCleared = false
  /** Counts failed inbox cancellation attempts. */
  let cancelAttempts = 0
  const harness = createResetHarness(session, {
    onCancel: () => { cancelAttempts++; throw new Error('no connection') },
    onReset: () => { reset = true },
    onPermissionsClear: () => { permissionsCleared = true },
  })
  try {
    await resetDuringSessionCreation(harness, session)

    assert.equal(cancelAttempts, 1)
    assert.equal(reset, false)
    assert.equal(permissionsCleared, false)
    assert.deepEqual(harness.sent, ['I could not reset the session. Try again.'])
  } finally {
    harness.restore()
  }
})
