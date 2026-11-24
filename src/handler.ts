/**
 * WhatsApp command routing, queueing, and response delivery.
 *
 * @remarks
 * Normal prompts run through a bounded queue so OpenCode sees one turn at a
 * time. Permission replies bypass that queue because the active prompt may be
 * waiting for the reply. `/reset` invalidates older work and waits for any
 * in-flight delivery before confirming the new session.
 */

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
 * Sends one response chunk with a small bounded retry policy.
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
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!isCurrent()) throw new Error('Response delivery cancelled by reset.')
    try {
      await deps.send(to, text)
      return
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }
  throw lastError
}

/**
 * Creates the single-user message handler used by the HTTP runtime.
 *
 * @param deps - Prompt, cancellation, permission, and delivery operations.
 * @returns An async function that accepts a sender and message text.
 */
export function createMessageHandler(deps: HandlerDeps) {
  /** Serializes normal prompts and `/help` messages. */
  let queue = Promise.resolve()
  /** Serializes `/reset` operations independently from normal prompts. */
  let resetQueue = Promise.resolve()
  /** Monotonic token used to discard work invalidated by `/reset`. */
  let generation = 0
  /** Number of normal turns active or waiting in the queue. */
  let pendingMessages = 0

  /**
   * Processes one queued, non-permission message.
   *
   * @param from - Sender phone number.
   * @param rawText - Original message text.
   * @param expectedGeneration - Generation captured when the message queued.
   */
  const processMessage = async (from: string, rawText: string, expectedGeneration: number): Promise<void> => {
    if (expectedGeneration !== generation) return
    const text = rawText.trim()
    if (!text) return
    console.info(JSON.stringify({ event: 'message.received', from, length: rawText.length }))

    try {
      if (text === '/help') {
        await deps.send(from, HELP)
        return
      }

      const reply = await deps.prompt(rawText)
      if (expectedGeneration !== generation) return
      const chunks = chunkText(reply)
      for (const chunk of chunks) {
        if (expectedGeneration !== generation) return
        await sendChunk(deps, from, chunk, () => expectedGeneration === generation)
      }
      console.info(JSON.stringify({ event: 'message.replied', from, chunks: chunks.length }))
    } catch (error) {
      if (expectedGeneration !== generation) return
      console.error('Failed to process message.', error)
      await deps.send(from, 'I could not process this now. Check the logs and try again.').catch(() => undefined)
      throw new MessageProcessingError(isRetryable(error))
    }
  }

  return async (from: string, text: string): Promise<void> => {
    if (from !== deps.allowedNumber) throw new Error('Unauthorized number.')

    // Approvals share the reset queue so a decision cannot race session cleanup.
    if (/^\/(yes|no)(?:\s|$)/i.test(text.trim())) {
      const task = resetQueue.then(async () => {
        try {
          const result = await deps.decidePermission(text.trim())
          if (result !== null) await deps.send(from, result)
        } catch (error) {
          console.error('Failed to decide permission.', error)
          await deps.send(from, 'I could not respond to the permission. Try again.').catch(() => undefined)
          throw new MessageProcessingError(false)
        }
      })
      resetQueue = task.catch((error) => console.error('Failed in permission queue.', error))
      await task
      return
    }

    if (text.trim() === '/reset') {
      generation++
      const pending = queue
      const task = resetQueue.then(async () => {
        try {
          await deps.cancel()
          await pending
          await deps.reset()
          await deps.send(from, 'Saved session cleared. Your next message starts with a clean context.')
        } catch (error) {
          console.error('Failed to reset the session.', error)
          await deps.send(from, 'I could not reset the session. Try again.').catch(() => undefined)
        }
      })
      resetQueue = task.catch((error) => console.error('Failed in reset queue.', error))
      queue = task.catch((error) => console.error('Failed in message queue.', error))
      await task
      return
    }

    if (pendingMessages >= 2) throw new QueueBusyError()
    pendingMessages++
    const expectedGeneration = generation
    const task = queue.then(() => processMessage(from, text, expectedGeneration))
    queue = task.finally(() => { pendingMessages-- }).catch((error) => console.error('Failed in message queue.', error))
    await task
  }
}
