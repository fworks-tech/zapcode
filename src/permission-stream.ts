/**
 * Reconnecting OpenCode permission event stream.
 *
 * @remarks
 * Establishes the subscription before reconciling missed requests, then keeps
 * consuming events until the bridge stops. Reconnect delays cannot keep the
 * process alive during shutdown.
 */

import type { OpenCodeClient } from './opencode.js'

/** Minimal event shape consumed from the OpenCode permission stream. */
export interface PermissionEvent {
  /** OpenCode event name. */
  type: string
  /** Event-specific payload. */
  data?: unknown
  /** Project location used to ignore events from other workdirs. */
  location?: { directory?: string } | undefined
}

/** Consumes events until the stream ends or shutdown is requested. */
async function consumeEvents(
  iterator: AsyncIterator<PermissionEvent>,
  isStopped: () => boolean,
  handleEvent: (event: PermissionEvent) => void,
): Promise<void> {
  while (!isStopped()) {
    const next = await iterator.next()
    if (next.done) return
    handleEvent(next.value)
  }
}

/**
 * Consumes permission events and reconciles after every connection.
 *
 * @param client - Authenticated OpenCode client.
 * @param isStopped - Returns whether the bridge requested shutdown.
 * @param handleEvent - Handles one event from the active stream.
 * @param reconcile - Refreshes requests missed before the connection.
 */
export async function listenForPermissions(
  client: OpenCodeClient,
  isStopped: () => boolean,
  handleEvent: (event: PermissionEvent) => void,
  reconcile: () => Promise<void>,
): Promise<void> {
  while (!isStopped()) {
    let closeStream: (() => void) | undefined
    try {
      const iterator = client.event.subscribe({ types: ['permission.asked', 'permission.replied'] })[Symbol.asyncIterator]()
      closeStream = () => {
        const closing = iterator.return?.()
        if (closing) void closing.catch(() => undefined)
      }
      const first = await iterator.next()
      if (!first.done) handleEvent(first.value)
      await reconcile()
      await consumeEvents(iterator, isStopped, handleEvent)
    } catch (error) {
      closeStream?.()
      console.error('Permission stream unavailable; reconnecting in 3s.', error)
    }
    if (!isStopped()) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3_000)
        timer.unref()
      })
    }
  }
}
