/**
 * OpenCode V2 client integration.
 *
 * @remarks
 * This module owns authentication, prompt admission, execution waiting,
 * response extraction, and confirmed cancellation. Prompt IDs are stable so
 * timeout and reset paths can cancel the exact inbox item they admitted.
 */

import { OpenCode } from '@opencode/client'

/** Authenticated Promise-based OpenCode V2 client type. */
export type OpenCodeClient = ReturnType<typeof OpenCode.make>

/** Signals that `/reset` invalidated an execution before it could finish. */
export class ExecutionCancelledError extends Error {
  /** Creates the cancellation error with a stable message. */
  constructor() {
    super('Execution cancelled by /reset.')
  }
}

/** Signals that timeout cleanup could not prove the execution was stopped. */
export class CancellationNotConfirmedError extends Error {
  /** Creates the unconfirmed-cancellation error. */
  constructor() {
    super('Could not confirm execution cancellation.')
  }
}

/** Minimal OpenCode message shape needed for response extraction. */
type Message = {
  /** Stable message identifier. */
  id: string
  /** OpenCode message category, such as `assistant`. */
  type: string
  /** Ordered content parts contained in the message. */
  content?: Array<{ type: string; text?: string }>
  /** Provider error returned by a failed assistant turn. */
  error?: unknown
  /** OpenCode finish reason. */
  finish?: string
}

/** Inputs required to submit one contextualized prompt. */
type PromptOptions = {
  /** Raw user message. */
  text: string
  /** Preloaded Markdown knowledge entries. */
  knowledge: string[]
  /** Stable ID used for prompt admission and inbox cancellation. */
  promptID: string
  /** External abort signal, normally owned by `/reset`. */
  signal?: AbortSignal
  /** Returns whether this execution still belongs to the active generation. */
  isCurrent?: () => boolean
  /** Called immediately before `session.prompt` is attempted. */
  onPromptAttempt?: () => void
}

/** Returns whether an error represents OpenCode's HTTP 404 response. */
function isNotFound(error: unknown): boolean {
  const value = error as { name?: unknown; status?: unknown; response?: { status?: unknown } } | null
  return value?.status === 404 || value?.response?.status === 404 ||
    (typeof value?.name === 'string' && value.name.endsWith('NotFoundError'))
}

/**
 * Creates an OpenCode client using HTTP Basic authentication.
 *
 * @param baseUrl - OpenCode server URL.
 * @param password - Password shared with `OPENCODE_PASSWORD` on the server.
 * @returns Configured OpenCode V2 client.
 */
export function createOpenCode(baseUrl: string, password: string): OpenCodeClient {
  /** Basic authorization header for the fixed `opencode` username. */
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  return OpenCode.make({ baseUrl, headers: { authorization } })
}

/**
 * Extracts the newest assistant text response from an OpenCode message list.
 *
 * @param response - Message-list response returned by OpenCode.
 * @param previousAssistantID - Assistant message that existed before the
 * prompt and must not be returned again.
 * @returns Joined text parts, or a fallback when no new text is present.
 * @throws When the newest assistant turn contains a provider error.
 */
export function extractReply(response: { data: Message[] }, previousAssistantID?: string): string {
  /** Newest assistant message in the API's requested order. */
  const assistant = response.data.find((message) => message.type === 'assistant')
  if (!assistant || assistant.id === previousAssistantID) return 'OpenCode finished without a text response.'
  if (assistant.error || assistant.finish === 'error') throw new Error('OpenCode assistant failed.')

  /** Text parts joined with blank lines and trimmed for WhatsApp delivery. */
  const text = assistant.content
    ?.filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n')
    .trim()
  return text || 'OpenCode finished without a text response.'
}

/**
 * Cancels one admitted inbox item and interrupts its session execution.
 *
 * @remarks
 * Missing sessions and unavailable inbox items are already cancelled. When
 * interruption reports `false`, active-session and inbox state must also show
 * that the target work is gone before success is returned.
 *
 * @param client - Authenticated OpenCode client.
 * @param sessionID - Session that owns the execution.
 * @param inboxID - Stable ID used when the prompt was admitted.
 * @throws When cancellation cannot be confirmed.
 */
export async function cancelExecution(client: OpenCodeClient, sessionID: string, inboxID: string): Promise<void> {
  const signal = AbortSignal.timeout(5_000)
  const results = await Promise.allSettled([
    client.session.inbox.cancel({ sessionID, inboxID }, { signal }),
    client.session.interrupt({ sessionID }, { signal }),
  ])
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected' && !isNotFound(result.reason))
  for (const failure of failures) console.error('Failed to cancel OpenCode execution.', failure.reason)
  if (failures.length > 0) throw new CancellationNotConfirmedError()

  const interruption = results[1]
  if (interruption?.status === 'fulfilled' && !interruption.value.interrupted) {
    try {
      const [active, inbox] = await Promise.all([
        client.session.active({ signal }),
        client.session.inbox.list({ sessionID }, { signal }),
      ])
      if (active[sessionID] || inbox.some((item) => item.id === inboxID)) throw new CancellationNotConfirmedError()
    } catch (error) {
      if (error instanceof CancellationNotConfirmedError) throw error
      throw new CancellationNotConfirmedError()
    }
  }
}

/**
 * Submits a prompt with knowledge context and waits for its final response.
 *
 * @param client - Authenticated OpenCode client.
 * @param sessionID - Persistent conversation session.
 * @param options - Prompt text, knowledge, stable ID, and cancellation hooks.
 * @returns The newest assistant text response.
 * @throws When reset invalidates the run, the 55-second deadline expires, the
 * assistant fails, or cancellation cannot be confirmed.
 */
export async function promptWithContext(
  client: OpenCodeClient,
  sessionID: string,
  options: PromptOptions,
): Promise<string> {
  /** Internal 55-second execution deadline. */
  const timeout = AbortSignal.timeout(55_000)
  /** Combined internal deadline and optional external reset signal. */
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  /** Generation check defaulting to current when no reset hook is supplied. */
  const isCurrent = options.isCurrent ?? (() => true)
  /** Throws before server work when reset already invalidated the run. */
  const throwIfStale = () => {
    if (!isCurrent()) throw new ExecutionCancelledError()
  }

  try {
    throwIfStale()
    /** Assistant message visible before this prompt, used to avoid stale replies. */
    const before = await client.message.list({ sessionID, order: 'desc', type: 'assistant', limit: 1 }, { signal })
    throwIfStale()
    /** Trusted knowledge block prepended to the user's message. */
    const context = options.knowledge.length > 0
      ? `TRUSTED KNOWLEDGE BASE CONTEXT:\n${options.knowledge.join('\n\n')}\n\nUse it when relevant. Do not invent missing information.`
      : 'No knowledge base is available; make that clear if relevant.'
    options.onPromptAttempt?.()
    await client.session.prompt({
      sessionID,
      id: options.promptID,
      text: `${context}\n\nUSER MESSAGE:\n${options.text}`,
    }, { signal })
    throwIfStale()
    await client.experimental.session.wait({ sessionID }, { signal })
    throwIfStale()
    /** Messages read after execution completes. */
    const after = await client.message.list({ sessionID, order: 'desc', type: 'assistant', limit: 20 }, { signal })
    throwIfStale()
    return extractReply(after, before.data[0]?.id)
  } catch (error) {
    if (error instanceof ExecutionCancelledError) throw error
    if (!isCurrent()) throw new ExecutionCancelledError()
    if (signal.aborted) {
      try {
        await cancelExecution(client, sessionID, options.promptID)
      } catch {
        throw new CancellationNotConfirmedError()
      }
      throw new Error('55s timeout elapsed. The execution and inbox item were cancelled; try a smaller request.')
    }
    throw error
  }
}
