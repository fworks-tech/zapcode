/**
 * Command routing and queue tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createMessageHandler } from '../src/handler.js'
import { deferred } from './helpers/runtime.js'
import { webhookConfig as config } from './helpers/webhook.js'

/** Verifies local command handling for `/reset` and `/help`. */
test('/reset clears the session and /help does not call the model', async () => {
  /** Captures messages sent back to the owner. */
  const sent: string[] = []
  /** Records whether reset reached its dependency. */
  let reset = false
  /** Counts normal model prompts. */
  let prompts = 0
  /** Handler with instrumented prompt, reset, and delivery dependencies. */
  const handler = createMessageHandler({
    prompt: async () => { prompts++; return 'response' },
    cancel: async () => undefined,
    reset: async () => { reset = true },
    decidePermission: async () => null,
    send: async (_to, text) => { sent.push(text) },
    allowedNumber: config.allowedNumber,
  })
  await handler('5511999999999', '/reset')
  await handler('5511999999999', '/help')
  assert.equal(reset, true)
  assert.equal(prompts, 0)
  assert.match(sent[0] ?? '', /Saved session/)
  assert.match(sent[1] ?? '', /\/yes/)
})

/** Verifies that reset cancels active work instead of waiting behind it. */
test('/reset cancels the active prompt without waiting for the queue', async () => {
  /** Promise that keeps the normal prompt pending until reset releases it. */
  const blocked = deferred<void>()
  /** Captures messages sent back to the owner. */
  const sent: string[] = []
  /** Records whether cancellation was requested. */
  let cancelled = false
  /** Records whether session reset was requested. */
  let reset = false
  /** Handler whose cancel dependency releases the blocked prompt. */
  const handler = createMessageHandler({
    prompt: async () => { await blocked.promise; return 'old response' },
    cancel: async () => { cancelled = true; blocked.resolve() },
    reset: async () => { reset = true },
    decidePermission: async () => null,
    send: async (_to, text) => { sent.push(text) },
    allowedNumber: config.allowedNumber,
  })
  /** Pending normal prompt started before reset. */
  const pending = handler('5511999999999', 'long task')
  await new Promise<void>((resolve) => setImmediate(resolve))
  await handler('5511999999999', '/reset')
  await pending
  assert.equal(cancelled, true)
  assert.equal(reset, true)
  assert.deepEqual(sent, ['Saved session cleared. Your next message starts with a clean context.'])
})

/** Verifies that permission approval bypasses the blocked prompt queue. */
test('/yes does not get stuck behind a prompt waiting for permission', async () => {
  /** Promise that simulates OpenCode waiting for permission. */
  const blocked = deferred<void>()
  /** Records whether the permission command was handled. */
  let decided = false
  /** Handler whose permission decision releases the blocked prompt. */
  const handler = createMessageHandler({
    prompt: async () => { await blocked.promise; return 'response' },
    cancel: async () => undefined,
    reset: async () => undefined,
    decidePermission: async () => { decided = true; blocked.resolve(); return 'Permission granted' },
    send: async () => undefined,
    allowedNumber: config.allowedNumber,
  })
  /** Pending prompt that waits for the permission reply. */
  const pending = handler('5511999999999', 'Edit the file')
  await new Promise<void>((resolve) => setImmediate(resolve))
  await handler('5511999999999', '/yes perm-1')
  assert.equal(decided, true)
  await pending
})
