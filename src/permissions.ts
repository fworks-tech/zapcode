/**
 * OpenCode permission approval bridge.
 *
 * @remarks
 * Permission events are streamed to WhatsApp, where the owner can reply with
 * `/yes` or `/no`. Live requests are scoped to the active session and project.
 * Reconciliation removes durable saved approvals, rejects policy-denied
 * requests, and replaces stale local state with the server's current state.
 */

import type { OpenCodeClient } from './opencode.js'
import {
  PermissionClearTracker,
  fetchPendingRequests,
  notifyPermission,
  rejectPermissionRequests,
  replyPermission,
} from './permission-actions.js'
import { listenForPermissions, type PermissionEvent } from './permission-stream.js'
import {
  enforcePermissionPolicy,
  isDeniedByPolicy,
  isNotFound,
  isRecord,
  matchesWorkdir,
  parseRequest,
  type PermissionRequest,
} from './permission-policy.js'

/** Tracks pending OpenCode permissions and delivers decisions through WhatsApp. */
export class PermissionBridge {
  /** Requests currently awaiting a decision, keyed by permission ID. */
  private readonly pending = new Map<string, PermissionRequest>()
  /** Requests whose complete WhatsApp notification was delivered. */
  private readonly notified = new Set<string>()
  /** In-flight notification promises awaited by reset cleanup. */
  private readonly notifications = new Map<string, Promise<void>>()
  /** Requests currently being rejected on the server. */
  private readonly rejecting = new Set<string>()
  /** Tracks late permission events while reset cleanup is active. */
  private readonly cleanup: PermissionClearTracker
  /** Session allowed to produce live approval prompts. */
  private activeSessionID: string | undefined
  /** Set by `stop()` to end the reconnecting event loop. */
  private stopped = false

  /**
   * Creates a permission bridge.
   *
   * @param client - Authenticated OpenCode client.
   * @param send - WhatsApp text delivery function.
   * @param owner - Only phone number allowed to answer permission requests.
   * @param workdir - Optional project directory used to filter events.
   */
  constructor(
    private readonly client: OpenCodeClient,
    private readonly send: (to: string, text: string) => Promise<void>,
    private readonly owner: string,
    private readonly workdir?: string,
  ) {
    this.cleanup = new PermissionClearTracker(client, (id) => this.forget(id))
  }

  /** Starts the background permission event listener. */
  start(): void {
    void listenForPermissions(
      this.client,
      () => this.stopped,
      (event) => this.handleEvent(event),
      () => this.syncPending(),
    )
  }

  /** Requests that the background listener stop after its current iteration. */
  stop(): void {
    this.stopped = true
  }

  /**
   * Selects the session whose permission events may be shown to the owner.
   *
   * @param sessionID - Active OpenCode session, or `undefined` after reset.
   */
  setActiveSession(sessionID: string | undefined): void {
    this.activeSessionID = sessionID
    if (!sessionID) {
      this.pending.clear()
      this.notified.clear()
    }
  }

  /** Refreshes saved approvals and pending permissions for the active session. */
  async reconcile(): Promise<void> {
    if (this.activeSessionID) await enforcePermissionPolicy(this.client, this.activeSessionID)
    await this.syncPending()
  }

  /**
   * Rejects every pending permission for the selected session.
   *
   * @remarks
   * Does nothing when no session is known, so reset cannot reject unrelated
   * OpenCode sessions in the same workdir.
   *
   * @param sessionID - Session to clear; defaults to the active session.
   * @throws If server reconciliation or any rejection fails.
   */
  async clear(sessionID: string | undefined = this.activeSessionID): Promise<void> {
    if (!sessionID) return
    this.cleanup.begin(sessionID)
    try {
      await enforcePermissionPolicy(this.client, sessionID)
      await this.syncPending(sessionID, false)
      const requests = [...this.pending.values()].filter((request) => request.sessionID === sessionID)
      const failed = await this.rejectRequests(requests)
      if (failed > 0) throw new Error(`Failed to reject ${failed} pending permission(s).`)
      await Promise.allSettled(this.notifications.values())
      await this.cleanup.finish()
    } finally {
      this.cleanup.reset()
    }
  }

  /**
   * Handles one permission event from the stream or startup reconciliation.
   *
   * @param event - Permission event to process.
   */
  handleEvent(event: PermissionEvent): void {
    if (this.workdir && !matchesWorkdir(event.location?.directory, this.workdir)) return
    if (event.type === 'permission.asked') {
      this.handleAsked(event.data)
      return
    }
    if (event.type === 'permission.replied') this.handleReplied(event.data)
  }

  /** Validates and tracks one asked event for the active session. */
  private handleAsked(data: unknown): void {
    const request = parseRequest(data)
    if (!request || !this.activeSessionID || request.sessionID !== this.activeSessionID) return
    if (this.cleanup.isClearing(request.sessionID)) {
      this.cleanup.rejectLate(request)
      return
    }
    if (isDeniedByPolicy(request)) {
      void this.rejectDenied(request)
      return
    }
    if (this.notified.has(request.id) || this.notifications.has(request.id)) return
    this.pending.set(request.id, request)
    this.trackNotification(request)
  }

  /** Starts one notification and removes its in-flight marker after settlement. */
  private trackNotification(request: PermissionRequest): void {
    const isCurrent = () => this.activeSessionID === request.sessionID &&
      this.pending.has(request.id) && !this.rejecting.has(request.id) && !this.cleanup.isClearing(request.sessionID)
    const notification = notifyPermission(this.send, this.owner, request, isCurrent).then((delivered) => {
      if (delivered) this.notified.add(request.id)
    })
    this.notifications.set(request.id, notification)
    void notification
      .finally(() => {
        if (this.notifications.get(request.id) === notification) this.notifications.delete(request.id)
      })
      .catch((error) => console.error(`Failed to send permission request ${request.id}.`, error))
  }

  /** Removes local state for a request answered outside this bridge. */
  private handleReplied(data: unknown): void {
    if (!isRecord(data) || typeof data.requestID !== 'string') return
    this.pending.delete(data.requestID)
    this.notified.delete(data.requestID)
  }

  /** Rejects a pending request that current bridge policy denies. */
  private async rejectDenied(request: PermissionRequest): Promise<void> {
    if (this.rejecting.has(request.id)) return
    this.rejecting.add(request.id)
    try {
      await replyPermission(this.client, request, 'reject', true)
      this.forget(request.id)
    } catch (error) {
      if (!isNotFound(error)) console.error(`Failed to reject denied permission ${request.id}.`, error)
    } finally {
      this.rejecting.delete(request.id)
    }
  }

  /**
   * Applies a `/yes` or `/no` command to a pending request.
   *
   * @param text - Trimmed command text.
   * @returns A user-facing result, or `null` when the text is not a command.
   */
  async decide(text: string): Promise<string | null> {
    const match = /^\/(yes|no)(?:\s+(\S+))?$/i.exec(text.trim())
    if (!match) return null
    const id = match[2] ?? (this.pending.size === 1 ? this.pending.keys().next().value : undefined)
    const request = id ? this.pending.get(id) : undefined
    if (!request) return 'No pending permission with that ID. Send /help.'
    return match[1]!.toLowerCase() === 'yes' ? this.allow(request) : this.reject(request)
  }

  /** Approves one fully delivered request, or explains why it cannot be approved. */
  private async allow(request: PermissionRequest): Promise<string> {
    if (!this.notified.has(request.id)) {
      return 'The complete permission request is still being sent. Wait for every chunk before approving.'
    }
    if (isDeniedByPolicy(request)) {
      await this.rejectDenied(request)
      return 'Permission denied by the current policy.'
    }
    try {
      await replyPermission(this.client, request, 'once')
    } catch (error) {
      if (!isNotFound(error)) throw error
      this.forget(request.id)
      return 'Permission was already handled.'
    }
    this.forget(request.id)
    return 'Permission granted once.'
  }

  /** Rejects every request owned by the selected request's session. */
  private async reject(request: PermissionRequest): Promise<string> {
    const requests = [...this.pending.values()].filter((item) => item.sessionID === request.sessionID)
    const failed = await this.rejectRequests(requests)
    return failed > 0
      ? `Failed to reject ${failed} permission(s). Try again using the ID.`
      : 'Permission rejected.'
  }

  /**
   * Rejects requests explicitly and removes only successful ones locally.
   *
   * @param requests - Permission requests to reject.
   * @returns Number of failed server-side rejections.
   */
  private async rejectRequests(requests: PermissionRequest[]): Promise<number> {
    requests.forEach((request) => this.rejecting.add(request.id))
    try {
      const results = await rejectPermissionRequests(this.client, requests)
      let failed = 0
      results.forEach((result, index) => {
        const request = requests[index]!
        if (result.status === 'fulfilled' || isNotFound(result.reason)) {
          this.forget(request.id)
        } else {
          failed++
          console.error(`Failed to reject permission ${request.id}.`, result.reason)
        }
      })
      return failed
    } finally {
      requests.forEach((request) => this.rejecting.delete(request.id))
    }
  }

  /** Removes one request from local decision and notification state. */
  private forget(id: string): void {
    this.pending.delete(id)
    this.notified.delete(id)
  }

  /**
   * Replaces local permission state with the server's current state.
   *
   * @param sessionID - Session to reconcile; defaults to the active session.
   * @param notify - Whether newly discovered requests should be sent to WhatsApp.
   */
  private async syncPending(sessionID: string | undefined = this.activeSessionID, notify = true): Promise<void> {
    const response = await fetchPendingRequests(this.client, this.workdir)
    if (!response) return
    const relevant = sessionID ? response.filter((request) => request.sessionID === sessionID) : response
    this.prunePending(sessionID, new Set(relevant.map((request) => request.id)))
    this.discoverPending(relevant, notify)
  }

  /** Removes local requests no longer present on the server. */
  private prunePending(sessionID: string | undefined, currentIDs: Set<string>): void {
    for (const [id, request] of this.pending) {
      if ((!sessionID || request.sessionID === sessionID) && !currentIDs.has(id)) this.forget(id)
    }
  }

  /** Notifies newly discovered requests or tracks them silently during reset. */
  private discoverPending(requests: PermissionRequest[], notify: boolean): void {
    for (const request of requests) {
      if (notify) {
        this.handleAsked(request)
      } else {
        const parsed = parseRequest(request)
        if (parsed && (!this.activeSessionID || parsed.sessionID === this.activeSessionID)) this.pending.set(parsed.id, parsed)
      }
    }
  }
}
