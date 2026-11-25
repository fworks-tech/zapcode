/**
 * Message runtime lifecycle for OpenCode executions.
 *
 * @remarks
 * The runtime registers work before session creation, persists the active
 * inbox ID, and uses generation tokens plus abort signals to make reset safe
 * across prompt admission, delivery, and bridge restarts.
 */

import { randomUUID } from 'node:crypto'

import type { Config } from './config.js'
import { createMessageHandler, RetryableMessageError } from './handler.js'
import { KnowledgeLimitError, loadKnowledge } from './knowledge.js'
import {
  cancelExecution,
  CancellationNotConfirmedError,
  ExecutionCancelledError,
  PreAdmissionError,
  promptWithContext,
  type OpenCodeClient,
} from './opencode.js'
import type { PermissionBridge } from './permissions.js'
import { SessionConfigurationError, SessionStateError, type SessionStore } from './session.js'
import { sendText } from './whatsapp.js'

/** External services required by the message runtime. */
interface RuntimeDeps {
  /** Validated bridge configuration. */
  config: Config
  /** Authenticated OpenCode client. */
  client: OpenCodeClient
  /** Session persistence operations used by prompt, reset, and recovery paths. */
  sessions: Pick<SessionStore, 'ensure' | 'reset' | 'currentSessionID' | 'getActiveRun' | 'markActive' | 'clearActive'>
  /** Permission operations used by reset and command paths. */
  permissions: Pick<PermissionBridge, 'clear' | 'decide' | 'setActiveSession' | 'reconcile'>
}

/** Bookkeeping for one prompt from pre-admission through completion. */
interface ActiveRun {
  /** Session ID, unavailable until `sessions.ensure()` resolves. */
  sessionID?: string
  /** Stable ID used for OpenCode prompt admission and inbox cancellation. */
  inboxID: string
  /** Abort controller owned by `/reset`. */
  controller: AbortController
  /** Resolves when the prompt executor exits, including cancellation cleanup. */
  finished: Promise<void>
}

/** Mutable state shared by prompt and cancellation executors. */
interface RuntimeState {
  /** Monotonic generation invalidated by every `/reset`. */
  generation: number
  /** Current run, retained when cancellation cannot be confirmed. */
  activeRun: ActiveRun | undefined
  /** Session currently allowed to produce permission prompts. */
  activeSessionID: string | undefined
  /** Prevents queued or new turns from entering OpenCode during shutdown. */
  shuttingDown: boolean
}

/**
 * Waits briefly for a run to finish after its abort signal is triggered.
 *
 * @param run - Active run to await.
 * @throws If the run does not finish within 12 seconds.
 */
async function waitForRun(run: ActiveRun): Promise<void> {
  /** Timeout used to reject the wait and allow cleanup in `finally`. */
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      run.finished,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out while waiting for execution cancellation.')), 12_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Attempts to confirm cancellation for a run that has a session ID.
 *
 * @param deps - Runtime services.
 * @param run - Run to cancel.
 * @returns `true` when no session exists or cancellation is confirmed.
 */
async function confirmCancellation(deps: RuntimeDeps, run: ActiveRun): Promise<boolean> {
  if (!run.sessionID) return true
  try {
    await cancelExecution(deps.client, run.sessionID, run.inboxID)
    return true
  } catch (error) {
    console.error('Cancellation not confirmed; keeping the execution tracked for another attempt.', error)
    return false
  }
}

/** Creates a synthetic run from state persisted before a bridge restart. */
function recoveredRun(saved: { sessionID: string; inboxID: string }): ActiveRun {
  return {
    sessionID: saved.sessionID,
    inboxID: saved.inboxID,
    controller: new AbortController(),
    finished: Promise.resolve(),
  }
}

/** Throws when reset invalidated the expected execution generation. */
function assertCurrent(state: RuntimeState, expectedGeneration: number): void {
  if (state.generation !== expectedGeneration) throw new ExecutionCancelledError()
}

/** Creates or loads the session, reconciles permissions, and loads knowledge. */
async function preparePrompt(
  state: RuntimeState,
  deps: RuntimeDeps,
  run: ActiveRun,
  expectedGeneration: number,
): Promise<{ sessionID: string; knowledge: string[] }> {
  const sessionID = await deps.sessions.ensure()
  run.sessionID = sessionID
  assertCurrent(state, expectedGeneration)
  state.activeSessionID = sessionID
  deps.permissions.setActiveSession(sessionID)
  await deps.permissions.reconcile()
  assertCurrent(state, expectedGeneration)
  await deps.sessions.markActive(run.inboxID)
  assertCurrent(state, expectedGeneration)
  const knowledge = await loadKnowledge(deps.config.knowledgeDir)
  assertCurrent(state, expectedGeneration)
  console.info(JSON.stringify({ event: 'opencode.prompt', sessionID }))
  return { sessionID, knowledge }
}

/** Returns whether setup failed for a reason retrying cannot fix. */
function isPermanentSetupError(error: unknown): boolean {
  return error instanceof SessionStateError || error instanceof SessionConfigurationError || error instanceof KnowledgeLimitError
}

/** Converts a prompt failure into cleanup and retry decisions. */
function classifyPromptFailure(error: unknown, enteredPrompt: boolean): {
  keepActive: boolean
  resetOwnsCleanup: boolean
  error: unknown
} {
  if (error instanceof ExecutionCancelledError) return { keepActive: false, resetOwnsCleanup: true, error }
  if (error instanceof CancellationNotConfirmedError) return { keepActive: true, resetOwnsCleanup: false, error }
  if (isPermanentSetupError(error)) return { keepActive: false, resetOwnsCleanup: false, error }
  if (error instanceof PreAdmissionError && error.retryable) {
    return { keepActive: false, resetOwnsCleanup: false, error: new RetryableMessageError() }
  }
  if (!enteredPrompt) return { keepActive: false, resetOwnsCleanup: false, error: new RetryableMessageError() }
  return { keepActive: false, resetOwnsCleanup: false, error }
}

/** Creates abort and completion bookkeeping for one prompt. */
function createActiveRun(): { run: ActiveRun; finish: () => void } {
  const controller = new AbortController()
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  return { run: { inboxID: `msg_${randomUUID()}`, controller, finished }, finish }
}

/** Registers one prompt after shutdown and restart-recovery checks. */
async function beginPrompt(
  state: RuntimeState,
  deps: RuntimeDeps,
): Promise<{ run: ActiveRun; finish: () => void; expectedGeneration: number }> {
  if (state.shuttingDown) throw new Error('zapcode is shutting down.')
  if (state.activeRun) throw new Error('The previous execution has not been cancelled. Send /reset to try again.')
  const expectedGeneration = state.generation
  const persisted = await deps.sessions.getActiveRun()
  assertCurrent(state, expectedGeneration)
  if (persisted) {
    state.activeRun = recoveredRun(persisted)
    throw new Error('The previous execution has not been cancelled. Send /reset to try again.')
  }
  const { run, finish } = createActiveRun()
  state.activeRun = run
  return { run, finish, expectedGeneration }
}

/**
 * Creates the normal-prompt executor used by the command handler.
 *
 * @param state - Shared generation, session, and active-run state.
 * @param deps - Runtime services.
 * @returns A function that submits one contextualized prompt.
 */
function createPromptExecutor(state: RuntimeState, deps: RuntimeDeps) {
  return async (text: string): Promise<string> => {
    const { run, finish, expectedGeneration } = await beginPrompt(state, deps)
    /** Keeps the run tracked when server-side cancellation fails. */
    let keepActive = false
    /** Records whether reset, rather than normal completion, owns cleanup. */
    let resetOwnsCleanup = false
    /** Records whether control passed to the OpenCode prompt helper. */
    let enteredPrompt = false
    try {
      const { sessionID, knowledge } = await preparePrompt(state, deps, run, expectedGeneration)
      enteredPrompt = true
      return await promptWithContext(deps.client, sessionID, {
        text,
        knowledge,
        promptID: run.inboxID,
        signal: run.controller.signal,
        isCurrent: () => state.generation === expectedGeneration,
      })
    } catch (error) {
      const failure = classifyPromptFailure(error, enteredPrompt)
      keepActive = failure.keepActive
      resetOwnsCleanup = failure.resetOwnsCleanup
      throw failure.error
    } finally {
      finish()
      if (!keepActive && !resetOwnsCleanup) await deps.sessions.clearActive(run.inboxID)
      if (!keepActive && state.activeRun === run) state.activeRun = undefined
    }
  }
}

/**
 * Creates the cancellation executor used by `/reset`.
 *
 * @param state - Shared generation, session, and active-run state.
 * @param deps - Runtime services.
 * @returns A function that invalidates and cancels current or recovered work.
 */
function createCancelExecutor(state: RuntimeState, deps: RuntimeDeps) {
  return async (): Promise<void> => {
    state.generation++
    let run = state.activeRun
    if (!run) {
      const persisted = await deps.sessions.getActiveRun()
      run = state.activeRun ?? (persisted ? recoveredRun(persisted) : undefined)
      if (!state.activeRun) state.activeRun = run
    }
    if (!run) return

    run.controller.abort()
    await waitForRun(run)
    if (!await confirmCancellation(deps, run)) throw new Error('Could not confirm execution cancellation.')
    await deps.sessions.clearActive(run.inboxID)
    if (state.activeRun === run) state.activeRun = undefined
  }
}

/** Cancels active or recovered work during process shutdown. */
function createRuntimeShutdown(state: RuntimeState, deps: RuntimeDeps) {
  return async (): Promise<void> => {
    state.shuttingDown = true
    await createCancelExecutor(state, deps)()
  }
}

/**
 * Connects the command handler to session, permission, OpenCode, and WhatsApp.
 *
 * @param deps - Runtime services.
 * @returns Single-user message handler and lifecycle state for shutdown.
 */
export function createMessageRuntime(deps: RuntimeDeps) {
  /** Fresh lifecycle state for this bridge process. */
  const state: RuntimeState = { generation: 0, activeRun: undefined, activeSessionID: undefined, shuttingDown: false }
  const handler = createMessageHandler({
    prompt: createPromptExecutor(state, deps),
    cancel: createCancelExecutor(state, deps),
    reset: async () => {
      const sessionID = state.activeSessionID ?? await deps.sessions.currentSessionID()
      if (sessionID) {
        deps.permissions.setActiveSession(sessionID)
        await deps.permissions.clear(sessionID)
        deps.permissions.setActiveSession(undefined)
      }
      try {
        await deps.sessions.reset(sessionID)
      } catch (error) {
        if (sessionID) {
          state.activeSessionID = sessionID
          deps.permissions.setActiveSession(sessionID)
          await deps.permissions.reconcile().catch((reconcileError) =>
            console.error('Failed to restore permission state after reset failure.', reconcileError))
        }
        throw error
      }
      state.activeSessionID = undefined
      deps.permissions.setActiveSession(undefined)
    },
    decidePermission: (text) => deps.permissions.decide(text),
    send: (to, text) => sendText(deps.config, to, text),
    allowedNumber: deps.config.allowedNumber,
  })
  return { handler, shutdown: createRuntimeShutdown(state, deps) }
}
