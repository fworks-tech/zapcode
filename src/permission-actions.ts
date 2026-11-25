/**
 * OpenCode permission delivery and server decisions.
 *
 * @remarks
 * Keeps WhatsApp chunking, bounded retries, and permission reply calls separate
 * from the bridge's pending-request state machine.
 */

import type { OpenCodeClient } from './opencode.js'
import { isNotFound, type PermissionRequest } from './permission-policy.js'
import { retryOperation } from './retry.js'
import { chunkText } from './whatsapp.js'

/** Decision accepted by the OpenCode permission API. */
type PermissionDecision = 'once' | 'reject'

/**
 * Sends every notification chunk and reports whether delivery completed.
 *
 * @param send - WhatsApp text delivery function.
 * @param owner - Phone number allowed to answer the request.
 * @param request - Permission request to display in full.
 * @param isCurrent - Returns whether the request still belongs to the active run.
 * @returns `true` only after the final chunk was delivered.
 */
export async function notifyPermission(
  send: (to: string, text: string) => Promise<void>,
  owner: string,
  request: PermissionRequest,
  isCurrent: () => boolean,
): Promise<boolean> {
  const resources = request.resources.join(', ')
  const message = `🔐 Permission requested (${request.id})\nAction: ${request.action}\nResource: ${resources}\n\n/yes ${request.id} = allow once\n/no ${request.id} = reject (also rejects pending requests in this session)`
  for (const chunk of chunkText(message)) {
    if (!isCurrent()) return false
    await retryOperation(() => send(owner, chunk), isCurrent)
  }
  return true
}

/**
 * Sends one permission decision to OpenCode.
 *
 * @param client - Authenticated OpenCode client.
 * @param request - Request selected by the owner or bridge policy.
 * @param decision - One-time approval or rejection.
 * @param retry - Whether transient failures use the shared bounded retry policy.
 */
export async function replyPermission(
  client: OpenCodeClient,
  request: PermissionRequest,
  decision: PermissionDecision,
  retry = false,
): Promise<void> {
  const operation = () => client.permission.reply(
    { sessionID: request.sessionID, requestID: request.id, decision },
    { signal: AbortSignal.timeout(10_000) },
  )
  if (retry) await retryOperation(operation)
  else await operation()
}

/**
 * Rejects requests in parallel without discarding failed requests.
 *
 * @param client - Authenticated OpenCode client.
 * @param requests - Requests selected for rejection.
 * @returns Settled results in the same order as the input.
 */
export async function rejectPermissionRequests(
  client: OpenCodeClient,
  requests: PermissionRequest[],
): Promise<PromiseSettledResult<void>[]> {
  return Promise.allSettled(requests.map((request) => replyPermission(client, request, 'reject')))
}

/**
 * Loads server-side pending requests, or returns `undefined` when unavailable.
 *
 * @param client - Authenticated OpenCode client.
 * @param workdir - Optional project location filter.
 * @returns Server requests, or `undefined` for a missing endpoint.
 */
export async function fetchPendingRequests(
  client: OpenCodeClient,
  workdir: string | undefined,
): Promise<PermissionRequest[] | undefined> {
  try {
    const response = await client.permission.request.list(
      workdir ? { location: { directory: workdir } } : undefined,
      { signal: AbortSignal.timeout(10_000) },
    )
    return response.data
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/** Tracks permission events that arrive while one session is being cleared. */
export class PermissionClearTracker {
  /** Session currently protected from new approval prompts. */
  private sessionID: string | undefined
  /** Late rejections that reset must await. */
  private readonly rejections = new Set<Promise<void>>()

  /**
   * Creates a cleanup tracker.
   *
   * @param client - Authenticated OpenCode client.
   * @param forget - Removes a request from local permission state.
   */
  constructor(
    private readonly client: OpenCodeClient,
    private readonly forget: (id: string) => void,
  ) {}

  /** Blocks new notifications for one session and starts collecting late events. */
  begin(sessionID: string): void {
    this.sessionID = sessionID
  }

  /** Returns whether a request belongs to the session currently being cleared. */
  isClearing(sessionID: string): boolean {
    return this.sessionID === sessionID
  }

  /** Rejects one late request and retains its promise until cleanup finishes. */
  rejectLate(request: PermissionRequest): void {
    const rejection = replyPermission(this.client, request, 'reject', true)
      .then(() => this.forget(request.id))
      .catch((error) => {
        if (!isNotFound(error)) throw error
        this.forget(request.id)
      })
    this.rejections.add(rejection)
    void rejection.catch((error) => console.error(`Failed to reject late permission ${request.id}.`, error))
  }

  /** Waits until every permission event received during cleanup is rejected. */
  async finish(): Promise<void> {
    while (this.rejections.size > 0) {
      const pending = [...this.rejections]
      const results = await Promise.allSettled(pending)
      pending.forEach((rejection) => this.rejections.delete(rejection))
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) throw failure.reason
    }
  }

  /** Clears session and promise bookkeeping after cleanup exits. */
  reset(): void {
    this.sessionID = undefined
    this.rejections.clear()
  }
}
