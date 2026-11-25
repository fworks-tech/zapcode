/**
 * WhatsApp command routing, queueing, and response delivery.
 *
 * @remarks
 * Normal prompts run through a bounded queue so OpenCode sees one turn at a
 * time. Permission replies bypass that queue because the active prompt may be
 * waiting for the reply. `/reset` invalidates older work and waits for any
 * in-flight delivery before confirming the new session.
 */

import { retryOperation } from './retry.js'
import { chunkText } from './whatsapp.js'

/** Help text sent when the owner requests `/help`. */
const HELP = `zapcode — commands:
/help = show this help
/reset = clear the OpenCode session
/yes <id> = allow a tool once
/no <id> = reject the permission and all pending requests in the session

Outside commands, send your question or task normally.`

/** Dependencies required to process one WhatsApp message. */
interface HandlerDeps {
  /**
   * Sends a normal prompt to OpenCode.
   *
   * @param text - User message without command routing.
   * @returns The final textual response.
   */
  prompt(text: string): Promise<string>
  /** Cancels the currently executing prompt, if any. */
  cancel(): Promise<void>
  /** Clears persisted session and permission state after cancellation. */
  reset(): Promise<void>
  /**
   * Handles `/yes` or `/no` permission commands.
   *
   * @param text - Trimmed command text.
   * @returns A user-facing result, or `null` when the text is not a command.
   */
  decidePermission(text: string): Promise<string | null>
  /**
   * Sends one WhatsApp text message.
   *
   * @param to - Destination phone number.
   * @param text - Message content.
   */
  send(to: string, text: string): Promise<void>
  /** Only phone number allowed to invoke the handler. */
  allowedNumber: string
}

/** Mutable queue and generation state for one handler instance. */
interface HandlerState {
  queue: Promise<void>
  resetQueue: Promise<void>
  generation: number
  pendingMessages: number
}

/** Signals that the single-session queue already has one active and one waiting turn. */
export class QueueBusyError extends Error {
  /** Creates the busy-queue error with its HTTP status. */
  constructor() {
    super('The OpenCode session is busy. Try again after the current turn finishes.')
    this.name = 'QueueBusyError'
    this.statusCode = 429
  }

  /** HTTP status returned to Evolution. */
  statusCode: number
}

/** Carries message-processing failure and retry safety to the webhook. */
class MessageProcessingError extends Error {
  /**
   * Creates a processing error.
   *
   * @param retryable - Whether Evolution may safely retry the same message.
   */
  constructor(readonly retryable: boolean) {
    super('Message processing failed.')
    this.name = 'MessageProcessingError'
  }
}

/** Signals a processing failure that is safe for Evolution to retry. */
export class RetryableMessageError extends Error {
  /** Creates a retryable message-processing error. */
  constructor() {
    super('Message processing failed before OpenCode admission.')
    this.name = 'RetryableMessageError'
  }
}

/** Returns whether an unknown error is safe to retry. */
function isRetryable(error: unknown): boolean {
  return error instanceof RetryableMessageError
}

/**
 * Sends one response chunk with the shared bounded retry policy.
 *
 * @param deps - Delivery dependencies.
 * @param to - Destination phone number.
 * @param text - Chunk content.
 * @param isCurrent - Generation check used to stop stale delivery.
 */
async function sendChunk(
  deps: HandlerDeps,
  to: string,
  text: string,
  isCurrent: () => boolean,
): Promise<void> {
  await retryOperation(() => deps.send(to, text), isCurrent)
}

/** Processes one queued, non-permission message. */
async function processMessage(
  deps: HandlerDeps,
  from: string,
  rawText: string,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return
  const text = rawText.trim()
  if (!text) return
  console.info(JSON.stringify({ event: 'message.received', from, length: rawText.length }))

  try {
    if (text === '/help') {
      await deps.send(from, HELP)
      return
    }

    const reply = await deps.prompt(rawText)
    if (!isCurrent()) return
    const chunks = chunkText(reply)
    for (const chunk of chunks) {
      if (!isCurrent()) return
      await sendChunk(deps, from, chunk, isCurrent)
    }
    console.info(JSON.stringify({ event: 'message.replied', from, chunks: chunks.length }))
  } catch (error) {
    if (!isCurrent()) return
    console.error('Failed to process message.', error)
    await deps.send(from, 'I could not process this now. Check the logs and try again.').catch(() => undefined)
    throw new MessageProcessingError(isRetryable(error))
  }
}

/** Runs a permission command in the reset queue. */
async function runPermissionCommand(state: HandlerState, deps: HandlerDeps, from: string, text: string): Promise<void> {
  const task = state.resetQueue.then(async () => {
    let result: string | null
    try {
      result = await deps.decidePermission(text)
    } catch (error) {
      console.error('Failed to decide permission.', error)
      await deps.send(from, 'I could not respond to the permission. Try again.').catch(() => undefined)
      throw new MessageProcessingError(false)
    }
    if (result !== null) {
      await deps.send(from, result).catch((error) => console.error('Permission decided but confirmation failed.', error))
    }
  })
  state.resetQueue = task.catch((error) => console.error('Failed in permission queue.', error))
  await task
}

/** Invalidates old work and performs reset in the reset queue. */
async function runReset(state: HandlerState, deps: HandlerDeps, from: string): Promise<void> {
  state.generation++
  const pending = state.queue
  const task = state.resetQueue.then(async () => {
    try {
      await deps.cancel()
      await pending
      await deps.reset()
    } catch (error) {
      console.error('Failed to reset the session.', error)
      await deps.send(from, 'I could not reset the session. Try again.').catch(() => undefined)
      return
    }
    await deps.send(from, 'Saved session cleared. Your next message starts with a clean context.')
      .catch((error) => console.error('Session reset but confirmation failed.', error))
  })
  state.resetQueue = task.catch((error) => console.error('Failed in reset queue.', error))
  state.queue = task.catch((error) => console.error('Failed in message queue.', error))
  await task
}

/** Enqueues one normal turn with bounded backpressure. */
async function runNormalMessage(state: HandlerState, deps: HandlerDeps, from: string, text: string): Promise<void> {
  if (state.pendingMessages >= 2) throw new QueueBusyError()
  state.pendingMessages++
  const expectedGeneration = state.generation
  const task = state.queue.then(() => processMessage(
    deps,
    from,
    text,
    () => state.generation === expectedGeneration,
  ))
  state.queue = task.finally(() => { state.pendingMessages-- }).catch((error) => console.error('Failed in message queue.', error))
  await task
}

/**
 * Creates the single-user message handler used by the HTTP runtime.
 *
 * @param deps - Prompt, cancellation, permission, and delivery operations.
 * @returns An async function that accepts a sender and message text.
 */
export function createMessageHandler(deps: HandlerDeps) {
  /** Fresh queue and generation state for this handler. */
  const state: HandlerState = { queue: Promise.resolve(), resetQueue: Promise.resolve(), generation: 0, pendingMessages: 0 }

  return async (from: string, text: string): Promise<void> => {
    if (from !== deps.allowedNumber) throw new Error('Unauthorized number.')
    if (/^\/(yes|no)(?:\s|$)/i.test(text.trim())) {
      await runPermissionCommand(state, deps, from, text.trim())
      return
    }
    if (text.trim() === '/reset') {
      await runReset(state, deps, from)
      return
    }
    await runNormalMessage(state, deps, from, text)
  }
}
