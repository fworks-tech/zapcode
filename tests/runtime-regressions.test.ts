/**
 * Runtime recovery, shutdown, and cancellation regression tests.
 *
 * @remarks
 * Covers persisted active runs, reset races, fail-closed cleanup, shutdown
 * admission, permission serialization, and interruption verification.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createMessageHandler } from '../src/handler.js'
import { cancelExecution, CancellationNotConfirmedError } from '../src/opencode.js'
import { createMessageRuntime } from '../src/runtime.js'

/** Phone number allowed by the runtime tests. */
const webhookConfig = { allowedNumber: '5511999999999' }

/** Complete runtime configuration used by recovery tests. */
const runtimeConfig = {
  openCodeUrl: 'http://127.0.0.1:4096',
  openCodePassword: 'opencode-password-with-32-characters',
  workdir: 'C:/Github/zapcode',
  knowledgeDir: 'C:/Github/zapcode/knowledge',
  sessionFile: 'C:/Github/zapcode/data/session.json',
  evolutionUrl: 'http://evolution',
  evolutionApiKey: 'api-key',
  evolutionInstance: 'zapcode',
  allowedNumber: webhookConfig.allowedNumber,
  webhookSecret: 'webhook-secret-with-32-characters',
  port: 3000,
}

/** Runtime test doubles that may be overridden per scenario. */
interface RuntimeHarnessOverrides {
  client?: Record<string, unknown>
  sessions?: Record<string, unknown>
  permissions?: Record<string, unknown>
}

/**
 * Builds a runtime with shared defaults and captures WhatsApp output.
 *
 * @param overrides - Boundary behavior that differs from the defaults.
 * @returns Runtime, sent messages, and a fetch restoration function.
 */
function createRuntimeHarness(overrides: RuntimeHarnessOverrides = {}) {
  /** WhatsApp messages captured from the mocked Evolution request. */
  const sent: string[] = []
  /** Original fetch restored by each test. */
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    if (init?.body) {
      const body = JSON.parse(String(init.body))
      sent.push(body.textMessage.text)
    }
    return Response.json({})
  }

  const sessions = {
    ensure: async () => 'session-1',
    reset: async () => undefined,
    currentSessionID: async () => 'session-1',
    getActiveRun: async () => undefined,
    markActive: async () => undefined,
    clearActive: async () => undefined,
    ...overrides.sessions,
  }
  const permissions = {
    clear: async () => undefined,
    decide: async () => null,
    setActiveSession: () => undefined,
    reconcile: async () => undefined,
    ...overrides.permissions,
  }
  const runtime = createMessageRuntime({
    config: runtimeConfig,
    client: (overrides.client ?? { session: {} }) as never,
    sessions: sessions as never,
    permissions: permissions as never,
  })
  return { runtime, sent, restore: () => { globalThis.fetch = originalFetch } }
}

/** Verifies that reset recovers and cancels a run persisted before restart. */
test('reset cancels an active run recovered from disk', async () => {
  /** Captures inbox cancellation requests. */
  const cancelled: unknown[] = []
  /** Records server-session removal. */
  let removed = false
  /** Records permission cleanup. */
  let cleared = false
  const harness = createRuntimeHarness({
    client: {
      session: {
        inbox: { cancel: async (input: unknown) => { cancelled.push(input) } },
        interrupt: async () => ({ interrupted: true }),
      },
    },
    sessions: {
      reset: async () => { removed = true },
      currentSessionID: async () => 'session-old',
      getActiveRun: async () => ({ sessionID: 'session-old', inboxID: 'msg-old' }),
    },
    permissions: { clear: async () => { cleared = true } },
  })
  try {
    await harness.runtime.handler(webhookConfig.allowedNumber, '/reset')
    assert.deepEqual(cancelled, [{ sessionID: 'session-old', inboxID: 'msg-old' }])
    assert.equal(cleared, true)
    assert.equal(removed, true)
    assert.deepEqual(harness.sent, ['Saved session cleared. Your next message starts with a clean context.'])
  } finally {
    harness.restore()
  }
})

/** Verifies that reset during active-run recovery prevents later prompt admission. */
test('reset during active-run recovery prevents session creation and admission', async () => {
  /** Resolver for the first active-run read. */
  let release!: () => void
  /** Promise controlling the prompt's recovery read. */
  const blocked = new Promise<void>((resolve) => { release = resolve })
  /** Resolver fired when the prompt starts its recovery read. */
  let markStarted!: () => void
  /** Promise that removes scheduling assumptions. */
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  /** Counts recovery reads. */
  let recoveryReads = 0
  /** Counts session ensure calls. */
  let ensureCalls = 0
  const harness = createRuntimeHarness({
    sessions: {
      ensure: async () => { ensureCalls++; return 'session-1' },
      currentSessionID: async () => undefined,
      getActiveRun: async () => {
        recoveryReads++
        if (recoveryReads === 1) {
          markStarted()
          await blocked
        }
        return undefined
      },
    },
  })
  try {
    const pending = harness.runtime.handler(webhookConfig.allowedNumber, 'old task')
    await started
    const resetting = harness.runtime.handler(webhookConfig.allowedNumber, '/reset')
    release()
    await Promise.all([pending, resetting])
    assert.equal(ensureCalls, 0)
    assert.deepEqual(harness.sent, ['Saved session cleared. Your next message starts with a clean context.'])
  } finally {
    harness.restore()
  }
})

/** Verifies that permission cleanup failure prevents session deletion. */
test('reset does not delete the session when permission cleanup fails', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Records whether session reset was incorrectly attempted. */
  let reset = false
  const harness = createRuntimeHarness({
    sessions: { reset: async () => { reset = true } },
    permissions: { clear: async () => { throw new Error('permission list failed') } },
  })
  try {
    await harness.runtime.handler(webhookConfig.allowedNumber, '/reset')
    assert.equal(reset, false)
    assert.deepEqual(harness.sent, ['I could not reset the session. Try again.'])
  } finally {
    harness.restore()
  }
})

/** Verifies that a recovered active run blocks new prompts before session creation. */
test('a recovered active run blocks new prompts until reset succeeds', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Counts session creation/reuse calls. */
  let ensureCalls = 0
  const harness = createRuntimeHarness({
    sessions: {
      ensure: async () => { ensureCalls++; return 'session-old' },
      currentSessionID: async () => 'session-old',
      getActiveRun: async () => ({ sessionID: 'session-old', inboxID: 'msg-old' }),
    },
  })
  try {
    await assert.rejects(harness.runtime.handler(webhookConfig.allowedNumber, 'new task'), /Message processing failed/)
    assert.equal(ensureCalls, 0)
  } finally {
    harness.restore()
  }
})

/** Verifies that shutdown blocks queued turns from entering OpenCode. */
test('shutdown prevents queued turns from starting after cancellation', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Resolver for session creation. */
  let release!: () => void
  /** Promise controlling the first prompt's session setup. */
  const blocked = new Promise<void>((resolve) => { release = resolve })
  /** Resolver fired when session setup starts. */
  let markStarted!: () => void
  /** Promise that removes scheduling assumptions. */
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  /** Counts session ensure calls. */
  let ensureCalls = 0
  const harness = createRuntimeHarness({
    client: {
      session: {
        inbox: { cancel: async () => undefined },
        interrupt: async () => ({ interrupted: true }),
      },
    },
    sessions: {
      ensure: async () => {
        ensureCalls++
        markStarted()
        await blocked
        return 'session-1'
      },
    },
  })
  try {
    const first = harness.runtime.handler(webhookConfig.allowedNumber, 'first')
    await started
    const second = harness.runtime.handler(webhookConfig.allowedNumber, 'second')
    const shuttingDown = harness.runtime.shutdown()
    release()
    await Promise.allSettled([first, second, shuttingDown])
    assert.equal(ensureCalls, 1)
  } finally {
    harness.restore()
  }
})

/** Verifies that permission decisions cannot overtake an active reset. */
test('permission decisions are serialized with reset', async () => {
  /** Resolver for the blocked permission decision. */
  let release!: () => void
  /** Promise controlling the decision. */
  const blocked = new Promise<void>((resolve) => { release = resolve })
  /** Records operation order. */
  const order: string[] = []
  const handler = createMessageHandler({
    prompt: async () => 'response',
    cancel: async () => { order.push('cancel') },
    reset: async () => { order.push('reset') },
    decidePermission: async () => {
      order.push('decision-start')
      await blocked
      order.push('decision-end')
      return 'granted'
    },
    send: async () => undefined,
    allowedNumber: webhookConfig.allowedNumber,
  })
  const decision = handler(webhookConfig.allowedNumber, '/yes perm-1')
  await new Promise<void>((resolve) => setImmediate(resolve))
  const resetting = handler(webhookConfig.allowedNumber, '/reset')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['decision-start'])
  release()
  await Promise.all([decision, resetting])
  assert.deepEqual(order, ['decision-start', 'decision-end', 'cancel', 'reset'])
})

/** Verifies that `interrupted: false` still checks active and inbox state. */
test('cancelExecution rejects an interrupted:false response when work remains', async () => {
  const client = {
    session: {
      inbox: { cancel: async () => undefined, list: async () => [{ id: 'msg-1' }] },
      interrupt: async () => ({ interrupted: false }),
      active: async () => ({ 'session-1': { type: 'running' } }),
    },
  }
  await assert.rejects(cancelExecution(client as never, 'session-1', 'msg-1'), CancellationNotConfirmedError)
})

/** Verifies that active-only work prevents cancellation confirmation. */
test('cancelExecution checks active state independently from inbox state', async () => {
  const client = {
    session: {
      inbox: { cancel: async () => undefined, list: async () => [] },
      interrupt: async () => ({ interrupted: false }),
      active: async () => ({ 'session-1': { type: 'running' } }),
    },
  }
  await assert.rejects(cancelExecution(client as never, 'session-1', 'msg-1'), CancellationNotConfirmedError)
})

/** Verifies that inbox-only work prevents cancellation confirmation. */
test('cancelExecution checks inbox state independently from active state', async () => {
  const client = {
    session: {
      inbox: { cancel: async () => undefined, list: async () => [{ id: 'msg-1' }] },
      interrupt: async () => ({ interrupted: false }),
      active: async () => ({}),
    },
  }
  await assert.rejects(cancelExecution(client as never, 'session-1', 'msg-1'), CancellationNotConfirmedError)
})

/** Verifies that failed state probes are reported as unconfirmed cancellation. */
test('cancelExecution fails closed when state probes fail', async () => {
  const client = {
    session: {
      inbox: { cancel: async () => undefined, list: async () => [] },
      interrupt: async () => ({ interrupted: false }),
      active: async () => { throw new Error('probe failed') },
    },
  }
  await assert.rejects(cancelExecution(client as never, 'session-1', 'msg-1'), CancellationNotConfirmedError)
})

/** Verifies that an idle `interrupted: false` response is accepted. */
test('cancelExecution accepts interrupted:false when the session is idle', async () => {
  const client = {
    session: {
      inbox: { cancel: async () => undefined, list: async () => [] },
      interrupt: async () => ({ interrupted: false }),
      active: async () => ({}),
    },
  }
  await cancelExecution(client as never, 'session-1', 'msg-1')
})
