/**
 * OpenCode permission approval bridge.
 *
 * @remarks
 * Permission events are streamed to WhatsApp, where the owner can reply with
 * `/yes` or `/no`. Live requests are scoped to the active session and project.
 * Reconciliation removes durable saved approvals, rejects policy-denied
 * requests, and replaces stale local state with the server's current state.
 */

import path from 'node:path'

import type { OpenCodeClient } from './opencode.js'
import { chunkText } from './whatsapp.js'

/**
 * Conservative permission rules applied to every OpenCode session.
 *
 * @remarks
 * OpenCode V2 uses the last matching rule. Broad asks therefore appear before
 * specific `.env*` denies. Grep and subagents remain blocked because their
 * permission inputs cannot safely enforce the required path boundary.
 */
export const SAFE_PERMISSIONS: Array<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }> = [
  { action: '*', resource: '*', effect: 'ask' },
  { action: 'external_directory', resource: '*', effect: 'deny' },
  { action: 'read', resource: '*', effect: 'ask' },
  { action: 'glob', resource: '*', effect: 'allow' },
  // shortcut: grep permission does not include the path, so it stays blocked until path validation exists.
  { action: 'grep', resource: '*', effect: 'deny' },
  { action: 'subagent', resource: '*', effect: 'deny' },
  { action: 'read', resource: '*.env*', effect: 'deny' },
  { action: 'edit', resource: '*.env*', effect: 'deny' },
  { action: 'question', resource: '*', effect: 'deny' },
]

/** Validated permission request stored while awaiting the owner's decision. */
interface PermissionRequest {
  /** OpenCode permission request ID used by `/yes` and `/no`. */
  id: string
  /** OpenCode session that owns the request. */
  sessionID: string
  /** Tool action requesting permission, such as `edit` or `shell`. */
  action: string
  /** Resource descriptions supplied by OpenCode. */
  resources: string[]
}

/** Minimal event shape consumed from the OpenCode permission stream. */
type PermissionEvent = {
  /** OpenCode event name. */
  type: string
  /** Event-specific payload. */
  data?: unknown
  /** Project location used to ignore events from other workdirs. */
  location?: { directory?: string } | undefined
}

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value - Untrusted value to inspect.
 * @returns `true` for non-null, non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates an OpenCode permission payload.
 *
 * @param value - Raw event data.
 * @returns A normalized request, or `null` when required fields are invalid.
 */
function parseRequest(value: unknown): PermissionRequest | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || typeof value.sessionID !== 'string' || typeof value.action !== 'string') return null
  if (!Array.isArray(value.resources) || !value.resources.every((resource) => typeof resource === 'string')) return null
  return { id: value.id, sessionID: value.sessionID, action: value.action, resources: value.resources }
}

/** Returns whether an error represents a missing OpenCode resource. */
function isNotFound(error: unknown): boolean {
  const value = error as { name?: unknown; status?: unknown; response?: { status?: unknown } } | null
  return value?.status === 404 || value?.response?.status === 404 ||
    (typeof value?.name === 'string' && value.name.endsWith('NotFoundError'))
}

/** Returns whether two filesystem paths identify the same directory. */
function samePath(left: string, right: string): boolean {
  const actual = path.resolve(left)
  const expected = path.resolve(right)
  return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
}

/** Returns whether current bridge policy denies a pending request. */
function isDeniedByPolicy(request: PermissionRequest): boolean {
  if (['external_directory', 'grep', 'subagent', 'question'].includes(request.action)) return true
  return (request.action === 'read' || request.action === 'edit') && request.resources.some((resource) => /\.env/i.test(resource))
}

/**
 * Tracks pending OpenCode permissions and delivers decisions through WhatsApp.
 */
export class PermissionBridge {
  /** Requests currently awaiting a decision, keyed by permission ID. */
  private readonly pending = new Map<string, PermissionRequest>()
  /** Requests whose complete WhatsApp notification was delivered. */
  private readonly notified = new Set<string>()
  /** In-flight notification promises awaited by reset cleanup. */
  private readonly notifications = new Map<string, Promise<void>>()
  /** Denied requests currently being rejected on the server. */
  private readonly rejecting = new Set<string>()
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
  ) {}

  /** Starts the background permission event listener. */
  start(): void {
    void this.listen()
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

  /** Removes durable project approvals that could bypass WhatsApp prompts. */
  private async enforcePolicy(sessionID: string): Promise<void> {
    const signal = AbortSignal.timeout(10_000)
    try {
      const session = await this.client.session.get({ sessionID }, { signal })
      const saved = await this.client.permission.saved.list({ projectID: session.projectID }, { signal })
      await Promise.all(saved.map((rule) => this.client.permission.saved.remove({ id: rule.id }, { signal })))
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }

  /** Refreshes saved approvals and pending permissions for the active session. */
  async reconcile(): Promise<void> {
    if (this.activeSessionID) await this.enforcePolicy(this.activeSessionID)
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
    await this.enforcePolicy(sessionID)
    await this.syncPending(sessionID, false)
    const requests = [...this.pending.values()].filter((request) => !sessionID || request.sessionID === sessionID)
    const failed = await this.rejectRequests(requests)
    if (failed > 0) throw new Error(`Failed to reject ${failed} pending permission(s).`)
    await Promise.allSettled(this.notifications.values())
  }

  /**
   * Handles one permission event from the stream or startup reconciliation.
   *
   * @param event - Permission event to process.
   */
  handleEvent(event: PermissionEvent): void {
    if (this.workdir) {
      if (!event.location?.directory || !samePath(event.location.directory, this.workdir)) return
    }
    if (event.type === 'permission.asked') {
      /** Validated request extracted from the event payload. */
      const request = parseRequest(event.data)
      if (!request || !this.activeSessionID || request.sessionID !== this.activeSessionID) return
      if (isDeniedByPolicy(request)) {
        void this.rejectDenied(request)
        return
      }
      if (this.notified.has(request.id)) return
      this.pending.set(request.id, request)
      const notification = this.notify(request)
      this.notifications.set(request.id, notification)
      void notification
        .finally(() => {
          if (this.notifications.get(request.id) === notification) this.notifications.delete(request.id)
        })
        .catch((error) => console.error(`Failed to send permission request ${request.id}.`, error))
      return
    }
    if (event.type === 'permission.replied' && isRecord(event.data) && typeof event.data.requestID === 'string') {
      this.pending.delete(event.data.requestID)
      this.notified.delete(event.data.requestID)
    }
  }

  /**
   * Sends the complete permission request in ordered WhatsApp chunks.
   *
   * @param request - Request that must be fully visible before approval.
   */
  private async notify(request: PermissionRequest): Promise<void> {
    const resources = request.resources.join(', ')
    const message = `🔐 Permission requested (${request.id})\nAction: ${request.action}\nResource: ${resources}\n\n/yes ${request.id} = allow once\n/no ${request.id} = reject (also rejects pending requests in this session)`
    for (const chunk of chunkText(message)) {
      if (this.activeSessionID !== request.sessionID || !this.pending.has(request.id)) return
      await this.send(this.owner, chunk)
    }
    this.notified.add(request.id)
  }

  /** Rejects a pending request that current bridge policy denies. */
  private async rejectDenied(request: PermissionRequest): Promise<void> {
    if (this.rejecting.has(request.id)) return
    this.rejecting.add(request.id)
    try {
      await this.client.permission.reply(
        { sessionID: request.sessionID, requestID: request.id, decision: 'reject' },
        { signal: AbortSignal.timeout(10_000) },
      )
      this.pending.delete(request.id)
      this.notified.delete(request.id)
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
    /** Parsed command and optional permission ID. */
    const match = /^\/(yes|no)(?:\s+(\S+))?$/i.exec(text.trim())
    if (!match) return null

    /** Explicit request ID, or the sole pending request when omitted. */
    const id = match[2] ?? (this.pending.size === 1 ? this.pending.keys().next().value : undefined)
    /** Pending request selected by the command. */
    const request = id ? this.pending.get(id) : undefined
    if (!request || !id) return 'No pending permission with that ID. Send /help.'

    /** Whether the owner chose to allow the request once. */
    const allow = match[1]!.toLowerCase() === 'yes'
    if (allow) {
      if (isDeniedByPolicy(request)) {
        await this.rejectDenied(request)
        return 'Permission denied by the current policy.'
      }
      try {
        await this.client.permission.reply(
          { sessionID: request.sessionID, requestID: request.id, decision: 'once' },
          { signal: AbortSignal.timeout(10_000) },
        )
      } catch (error) {
        if (!isNotFound(error)) throw error
        this.pending.delete(request.id)
        this.notified.delete(request.id)
        return 'Permission was already handled.'
      }
      this.pending.delete(request.id)
      this.notified.delete(request.id)
      return 'Permission granted once.'
    }

    /** Every pending request owned by the same OpenCode session. */
    const requests = [...this.pending.values()].filter((item) => item.sessionID === request.sessionID)
    /** Count of server-side rejections that failed. */
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
    /** Settled result for each explicit rejection call. */
    const results = await Promise.allSettled(requests.map((request) => this.client.permission.reply(
      { sessionID: request.sessionID, requestID: request.id, decision: 'reject' },
      { signal: AbortSignal.timeout(10_000) },
    )))
    /** Running count of rejections that did not succeed. */
    let failed = 0
    results.forEach((result, index) => {
      /** Request corresponding to the current settled result. */
      const request = requests[index]!
      if (result.status === 'fulfilled' || isNotFound(result.reason)) {
        this.pending.delete(request.id)
        this.notified.delete(request.id)
      } else {
        failed++
        console.error(`Failed to reject permission ${request.id}.`, result.reason)
      }
    })
    return failed
  }

  /** Maintains the permission stream and reconciles missed requests on reconnect. */
  private async listen(): Promise<void> {
    while (!this.stopped) {
      /** Optional iterator cleanup invoked when the stream fails. */
      let closeStream: (() => void) | undefined
      try {
        /** Async iterator for permission events. */
        const iterator = this.client.event.subscribe({ types: ['permission.asked', 'permission.replied'] })[Symbol.asyncIterator]()
        closeStream = () => {
          /** Promise returned by the iterator's optional `return()` method. */
          const closing = iterator.return?.()
          if (closing) void closing.catch(() => undefined)
        }
        /** First event proves that the server subscription is established. */
        const first = await iterator.next()
        if (!first.done) this.handleEvent(first.value)
        await this.syncPending()
        while (!this.stopped) {
          /** Next event from the established stream. */
          const next = await iterator.next()
          if (next.done) break
          this.handleEvent(next.value)
        }
      } catch (error) {
        closeStream?.()
        console.error('Permission stream unavailable; reconnecting in 3s.', error)
      }
      if (!this.stopped) {
        await new Promise((resolve) => {
          /** Unref'd reconnect delay so it cannot keep the process alive. */
          const timer = setTimeout(resolve, 3_000)
          timer.unref()
        })
      }
    }
  }

  /**
   * Replaces local permission state with the server's current state.
   *
   * @param sessionID - Session to reconcile; defaults to the active session.
   * @param notify - Whether newly discovered requests should be sent to WhatsApp.
   */
  private async syncPending(sessionID: string | undefined = this.activeSessionID, notify = true): Promise<void> {
    /** Pending permission list returned by OpenCode. */
    let response: { data: PermissionRequest[] }
    try {
      response = await this.client.permission.request.list(
        this.workdir ? { location: { directory: this.workdir } } : undefined,
        { signal: AbortSignal.timeout(10_000) },
      )
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
    const relevant = sessionID ? response.data.filter((request) => request.sessionID === sessionID) : response.data
    const currentIDs = new Set(relevant.map((request) => request.id))
    for (const [id, request] of this.pending) {
      if ((!sessionID || request.sessionID === sessionID) && !currentIDs.has(id)) {
        this.pending.delete(id)
        this.notified.delete(id)
      }
    }
    for (const request of relevant) {
      if (notify) {
        this.handleEvent({
          type: 'permission.asked',
          data: request,
          ...(this.workdir ? { location: { directory: this.workdir } } : {}),
        })
      } else {
        const parsed = parseRequest(request)
        if (parsed && (!this.activeSessionID || parsed.sessionID === this.activeSessionID)) this.pending.set(parsed.id, parsed)
      }
    }
  }
}
