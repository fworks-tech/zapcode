/**
 * OpenCode V2 client integration.
 *
 * @remarks
 * This module owns authentication, prompt admission, execution waiting,
 * response extraction, and confirmed cancellation. Prompt IDs are stable so
 * timeout and reset paths can cancel the exact inbox item they admitted.
 */

import { OpenCode, isSessionBusyError, isUnauthorizedError } from '@opencode/client'

import { isNotFound } from './permission-policy.js'

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

/** Signals that setup failed before a prompt could be admitted. */
export class PreAdmissionError extends Error {
  /**
   * Creates a pre-admission error.
   *
   * @param message - Safe explanation for logs and the owner.
   * @param retryable - Whether Evolution may retry the same message.
   * @param options - Optional original error cause.
   */
  constructor(message: string, readonly retryable: boolean, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PreAdmissionError'
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
}

/** Returns whether OpenCode explicitly rejected a prompt before admission. */
function isKnownRejection(error: unknown): boolean {
  const value = error as { name?: unknown; status?: unknown; response?: { status?: unknown } } | null
  const status = value?.status ?? value?.response?.status
  return isSessionBusyError(error) || isUnauthorizedError(error) ||
    status === 400 || status === 401 || status === 404 || status === 409 || status === 422 ||
    (typeof value?.name === 'string' && /(?:InvalidRequest|BadRequest|Conflict|UnprocessableEntity|NotFound|SessionBusy|Unauthorized)Error$/.test(value.name))
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

/** Cancels work when prompt admission is confirmed or uncertain. */
async function cancelUncertainWork(client: OpenCodeClient, sessionID: string, inboxID: string): Promise<void> {
  try {
    await cancelExecution(client, sessionID, inboxID)
  } catch {
    throw new CancellationNotConfirmedError()
  }
}

/** Runtime facts used to classify a failed prompt safely. */
interface PromptFailureContext {
  client: OpenCodeClient
  sessionID: string
  promptID: string
  signal: AbortSignal
  isCurrent: () => boolean
  promptAttempted: boolean
  admissionConfirmed: boolean
}

/** Throws the correct public error after applying cancellation policy. */
async function throwPromptFailure(error: unknown, context: PromptFailureContext): Promise<never> {
  if (error instanceof ExecutionCancelledError) throw error
  if (!context.isCurrent()) throw new ExecutionCancelledError()
  if (context.signal.aborted) {
    if (!context.promptAttempted) {
      throw new PreAdmissionError('Setup timed out before prompt admission.', true, { cause: error })
    }
    await cancelUncertainWork(context.client, context.sessionID, context.promptID)
    throw new Error('55s timeout elapsed. The execution and inbox item were cancelled; try a smaller request.')
  }
  if (!context.promptAttempted) {
    throw new PreAdmissionError('OpenCode setup failed before prompt admission.', true, { cause: error })
  }
  if (!context.admissionConfirmed && isKnownRejection(error)) {
    throw new PreAdmissionError('OpenCode rejected the prompt before admission.', false, { cause: error })
  }
  await cancelUncertainWork(context.client, context.sessionID, context.promptID)
  throw error
}

/** Builds the trusted knowledge block prepended to a user message. */
function buildPromptContext(knowledge: string[]): string {
  return knowledge.length > 0
    ? `TRUSTED KNOWLEDGE BASE CONTEXT:\n${knowledge.join('\n\n')}\n\nUse it when relevant. Do not invent missing information.`
    : 'No knowledge base is available; make that clear if relevant.'
}

/** Admission facts updated while one prompt is submitted. */
interface AdmissionState {
  /** Whether `session.prompt` may have reached the server. */
  promptAttempted: boolean
  /** Whether OpenCode confirmed prompt admission. */
  admissionConfirmed: boolean
}

/** Inputs shared by the successful prompt path. */
interface PromptExecution {
  /** Authenticated OpenCode client. */
  client: OpenCodeClient
  /** Persistent conversation session. */
  sessionID: string
  /** Prompt content and stable inbox ID. */
  options: PromptOptions
  /** Combined timeout and reset signal. */
  signal: AbortSignal
  /** Returns whether reset invalidated the run. */
  isCurrent: () => boolean
  /** Mutable admission facts for failure classification. */
  admission: AdmissionState
}

/** Throws when reset invalidated the current execution. */
function assertCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new ExecutionCancelledError()
}

/** Runs the successful prompt path and records admission uncertainty. */
async function executePrompt(execution: PromptExecution): Promise<string> {
  const { client, sessionID, options, signal, isCurrent, admission } = execution
  assertCurrent(isCurrent)
  const before = await client.message.list({ sessionID, order: 'desc', type: 'assistant', limit: 1 }, { signal })
  assertCurrent(isCurrent)
  const context = buildPromptContext(options.knowledge)
  admission.promptAttempted = true
  await client.session.prompt({
    sessionID,
    id: options.promptID,
    text: `${context}\n\nUSER MESSAGE:\n${options.text}`,
  }, { signal })
  admission.admissionConfirmed = true
  assertCurrent(isCurrent)
  await client.experimental.session.wait({ sessionID }, { signal })
  assertCurrent(isCurrent)
  const after = await client.message.list({ sessionID, order: 'desc', type: 'assistant', limit: 20 }, { signal })
  assertCurrent(isCurrent)
  return extractReply(after, before.data[0]?.id)
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
  const timeout = AbortSignal.timeout(55_000)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  const isCurrent = options.isCurrent ?? (() => true)
  const admission: AdmissionState = { promptAttempted: false, admissionConfirmed: false }
  try {
    return await executePrompt({ client, sessionID, options, signal, isCurrent, admission })
  } catch (error) {
    return await throwPromptFailure(error, {
      client,
      sessionID,
      promptID: options.promptID,
      signal,
      isCurrent,
      promptAttempted: admission.promptAttempted,
      admissionConfirmed: admission.admissionConfirmed,
    })
  }
}
