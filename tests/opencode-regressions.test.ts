/**
 * OpenCode admission and cancellation regression tests.
 *
 * @remarks
 * Proves that known pre-admission failures never interrupt a session, while
 * uncertain transport failures after a prompt attempt do cancel exact work.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { PreAdmissionError, promptWithContext } from '../src/opencode.js'

/** Verifies that a pre-list timeout does not interrupt unsubmitted work. */
test('a pre-list timeout does not cancel the session', async (testContext) => {
  /** Manually controlled deadline signal. */
  const controller = new AbortController()
  testContext.mock.method(AbortSignal, 'timeout', () => controller.signal)
  /** Counts prompt admissions. */
  let prompts = 0
  /** Counts interruption calls. */
  let interruptions = 0
  const client = {
    message: {
      list: async () => {
        controller.abort()
        throw new DOMException('Aborted', 'AbortError')
      },
    },
    session: {
      prompt: async () => { prompts++; return {} },
      interrupt: async () => { interruptions++; return { interrupted: true } },
      inbox: { cancel: async () => undefined },
    },
  }
  await assert.rejects(promptWithContext(client as never, 'session-1', {
    text: 'task',
    knowledge: [],
    promptID: 'msg-timeout',
  }), (error) => error instanceof PreAdmissionError && error.retryable)
  assert.equal(prompts, 0)
  assert.equal(interruptions, 0)
})

/** Verifies that a non-timeout pre-list failure does not cancel unsubmitted work. */
test('a pre-list transport failure does not cancel the session', async () => {
  /** Counts prompt admissions. */
  let prompts = 0
  /** Counts inbox cancellation calls. */
  let cancellations = 0
  /** Counts interruption calls. */
  let interruptions = 0
  const client = {
    message: { list: async () => { throw new TypeError('fetch failed') } },
    session: {
      prompt: async () => { prompts++; return {} },
      interrupt: async () => { interruptions++; return { interrupted: true } },
      inbox: { cancel: async () => { cancellations++ } },
    },
  }
  await assert.rejects(promptWithContext(client as never, 'session-1', {
    text: 'task',
    knowledge: [],
    promptID: 'msg-pre-list-failure',
  }), (error) => error instanceof PreAdmissionError && error.retryable)
  assert.equal(prompts, 0)
  assert.equal(cancellations, 0)
  assert.equal(interruptions, 0)
})

/** Verifies that a known prompt rejection is non-retryable and does not cancel. */
test('a known prompt rejection does not interrupt the session', async () => {
  /** Counts interruption calls. */
  let interruptions = 0
  const client = {
    message: { list: async () => ({ data: [] }) },
    session: {
      prompt: async () => { throw Object.assign(new Error('bad request'), { status: 400 }) },
      interrupt: async () => { interruptions++; return { interrupted: true } },
      inbox: { cancel: async () => undefined },
    },
  }
  await assert.rejects(promptWithContext(client as never, 'session-1', {
    text: 'invalid task',
    knowledge: [],
    promptID: 'msg-rejected',
  }), (error) => error instanceof PreAdmissionError && !error.retryable)
  assert.equal(interruptions, 0)

  /** Counts interruptions for the declared-error rejection. */
  let declaredInterruptions = 0
  const declaredErrorClient = {
    message: { list: async () => ({ data: [] }) },
    session: {
      prompt: async () => { throw Object.assign(new Error('invalid'), { name: 'InvalidRequestError' }) },
      interrupt: async () => { declaredInterruptions++; return { interrupted: true } },
      inbox: { cancel: async () => undefined },
    },
  }
  await assert.rejects(promptWithContext(declaredErrorClient as never, 'session-1', {
    text: 'invalid task',
    knowledge: [],
    promptID: 'msg-declared-rejection',
  }), (error) => error instanceof PreAdmissionError && !error.retryable)
  assert.equal(declaredInterruptions, 0)
})

/** Verifies that generated busy and unauthorized rejections never cancel a session. */
test('declared busy and unauthorized rejections do not cancel the session', async () => {
  for (const _tag of ['SessionBusyError', 'UnauthorizedError']) {
    /** Counts interruption calls for this rejection. */
    let interruptions = 0
    /** Counts inbox cancellation calls for this rejection. */
    let cancellations = 0
    const client = {
      message: { list: async () => ({ data: [] }) },
      session: {
        prompt: async () => { throw { _tag } },
        interrupt: async () => { interruptions++; return { interrupted: true } },
        inbox: { cancel: async () => { cancellations++ } },
      },
    }
    await assert.rejects(promptWithContext(client as never, 'session-1', {
      text: 'task',
      knowledge: [],
      promptID: `msg-${_tag}`,
    }), (error) => error instanceof PreAdmissionError && !error.retryable)
    assert.equal(interruptions, 0)
    assert.equal(cancellations, 0)
  }
})

/** Verifies that an uncertain transport failure after prompt attempt cancels work. */
test('an uncertain prompt transport failure cancels the exact inbox item', async () => {
  /** Captures inbox cancellation requests. */
  const cancelled: unknown[] = []
  /** Captures session interruption requests. */
  const interrupted: unknown[] = []
  const client = {
    message: { list: async () => ({ data: [] }) },
    session: {
      prompt: async () => { throw new TypeError('fetch failed') },
      interrupt: async (input: unknown) => { interrupted.push(input); return { interrupted: true } },
      inbox: { cancel: async (input: unknown) => { cancelled.push(input) } },
    },
  }
  await assert.rejects(promptWithContext(client as never, 'session-1', {
    text: 'task',
    knowledge: [],
    promptID: 'msg-uncertain',
  }), /fetch failed/)
  assert.deepEqual(cancelled, [{ sessionID: 'session-1', inboxID: 'msg-uncertain' }])
  assert.deepEqual(interrupted, [{ sessionID: 'session-1' }])
})
