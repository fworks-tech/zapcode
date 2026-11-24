/**
 * Runtime lifecycle tests for reset and cancellation races.
 *
 * @remarks
 * These tests defer session creation to reproduce `/reset` arriving before
 * prompt admission, then verify stale work cannot run or report success.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { Config } from '../src/config.js'
import { createMessageRuntime } from '../src/runtime.js'

/** Phone number allowed by the runtime tests. */
const owner = '5511999999999'

/** Complete configuration fixture used by the runtime tests. */
const config: Config = {
  openCodeUrl: 'http://127.0.0.1:4096',
  openCodePassword: 'opencode-password-with-32-characters',
  workdir: 'C:/Github/zapcode',
  knowledgeDir: 'C:/Github/zapcode/knowledge',
  sessionFile: 'C:/Github/zapcode/data/session.json',
  evolutionUrl: 'http://evolution',
  evolutionApiKey: 'api-key',
  evolutionInstance: 'zapcode',
  allowedNumber: owner,
  webhookSecret: 'webhook-secret-with-32-characters',
  port: 3000,
}

/**
 * Creates a manually controlled promise.
 *
 * @returns The pending promise and its resolver.
 */
function deferred<T>() {
  /** Resolver captured from the promise constructor. */
  let resolve!: (value: T) => void
  /** Promise completed later by the test. */
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** Builds the shared session and permission doubles used by reset-race tests. */
function createStateDoubles() {
  return {
    sessions: {
      ensure: () => Promise.resolve('session-1'),
      reset: async () => undefined,
      currentSessionID: async () => 'session-1',
      getActiveRun: async () => undefined,
      markActive: async () => undefined,
      clearActive: async () => undefined,
    },
    permissions: {
      clear: async () => undefined,
      decide: async () => null,
      setActiveSession: () => undefined,
      reconcile: async () => undefined,
    },
  }
}

/** Verifies that reset during session creation prevents old prompt admission. */
test('reset before sessions.ensure prevents old admission and cleans up afterwards', async () => {
  /** Deferred session ID used to pause `sessions.ensure()`. */
  const session = deferred<string>()
  /** Captures WhatsApp messages sent by the runtime. */
  const sent: string[] = []
  /** Captures OpenCode inbox cancellation requests. */
  const cancelled: unknown[] = []
  /** Records whether the stale prompt reached OpenCode. */
  let admitted = false
  /** Records whether persisted session cleanup ran. */
  let reset = false
  /** Records whether pending permissions were cleared. */
  let permissionsCleared = false
  /** Original global fetch restored after the test. */
  const originalFetch = globalThis.fetch
  /** Fetch mock that captures Evolution text messages. */
  globalThis.fetch = async (_input, init) => {
    /** Parsed Evolution request body. */
    const body = JSON.parse(String(init?.body))
    sent.push(body.textMessage.text)
    return Response.json({})
  }
  /** Mock OpenCode client with prompt and cancellation spies. */
  const client = {
    session: {
      prompt: async () => { admitted = true; return { id: 'msg-old' } },
      inbox: { cancel: async (input: unknown) => { cancelled.push(input) } },
      interrupt: async () => ({ interrupted: true }),
    },
  }
  /** Shared doubles customized for this race. */
  const doubles = createStateDoubles()
  doubles.sessions.ensure = () => session.promise
  doubles.sessions.reset = async () => { reset = true }
  doubles.permissions.clear = async () => { permissionsCleared = true }
  try {
    /** Runtime assembled from the mocked boundaries. */
    const runtime = createMessageRuntime({ config, client: client as never, sessions: doubles.sessions as never, permissions: doubles.permissions as never })
    /** Old prompt paused inside session creation. */
    const pending = runtime.handler(owner, 'old task')
    await new Promise<void>((resolve) => setImmediate(resolve))
    /** Reset operation started while the old prompt is still pre-admission. */
    const resetting = runtime.handler(owner, '/reset')
    await new Promise<void>((resolve) => setImmediate(resolve))
    session.resolve('session-old')
    await Promise.all([pending, resetting])

    assert.equal(admitted, false)
    assert.equal(reset, true)
    assert.equal(permissionsCleared, true)
    assert.ok(cancelled.length >= 1)
    assert.ok(cancelled.every((item) => (item as { sessionID: string }).sessionID === 'session-old'))
    assert.match((cancelled[0] as { inboxID: string }).inboxID, /^msg_/)
    assert.deepEqual(sent, ['Saved session cleared. Your next message starts with a clean context.'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

/** Verifies that reset does not report success when cancellation fails. */
test('reset does not confirm success when cancellation fails', async (testContext) => {
  testContext.mock.method(console, 'error', () => undefined)
  /** Deferred session ID used to pause `sessions.ensure()`. */
  const session = deferred<string>()
  /** Captures WhatsApp messages sent by the runtime. */
  const sent: string[] = []
  /** Records whether persisted session cleanup ran. */
  let reset = false
  /** Records whether pending permissions were cleared. */
  let permissionsCleared = false
  /** Counts failed inbox cancellation attempts. */
  let cancelAttempts = 0
  /** Original global fetch restored after the test. */
  const originalFetch = globalThis.fetch
  /** Fetch mock that captures Evolution text messages. */
  globalThis.fetch = async (_input, init) => {
    /** Parsed Evolution request body. */
    const body = JSON.parse(String(init?.body))
    sent.push(body.textMessage.text)
    return Response.json({})
  }
  /** Mock OpenCode client whose inbox cancellation always fails. */
  const client = {
    session: {
      inbox: { cancel: async () => { cancelAttempts++; throw new Error('no connection') } },
      interrupt: async () => ({ interrupted: true }),
    },
  }
  /** Shared doubles customized for this race. */
  const doubles = createStateDoubles()
  doubles.sessions.ensure = () => session.promise
  doubles.sessions.reset = async () => { reset = true }
  doubles.permissions.clear = async () => { permissionsCleared = true }
  try {
    /** Runtime assembled from the mocked boundaries. */
    const runtime = createMessageRuntime({ config, client: client as never, sessions: doubles.sessions as never, permissions: doubles.permissions as never })
    /** Old prompt paused inside session creation. */
    const pending = runtime.handler(owner, 'old task')
    await new Promise<void>((resolve) => setImmediate(resolve))
    /** Reset operation that must fail closed. */
    const resetting = runtime.handler(owner, '/reset')
    await new Promise<void>((resolve) => setImmediate(resolve))
    session.resolve('session-old')
    await Promise.all([pending, resetting])

    assert.equal(cancelAttempts, 1)
    assert.equal(reset, false)
    assert.equal(permissionsCleared, false)
    assert.deepEqual(sent, ['I could not reset the session. Try again.'])
  } finally {
    globalThis.fetch = originalFetch
  }
})
