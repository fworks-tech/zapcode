/**
 * HTTP boundary for zapcode.
 *
 * @remarks
 * The webhook authenticates before parsing JSON, validates the payload and
 * phone number, and tracks duplicate messages through pending and completed
 * states. Only retryable failures release an ID for another delivery.
 */

import { timingSafeEqual } from 'node:crypto'
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express'

import type { Config } from './config.js'
import { extractIncoming, normalizeNumber, type IncomingMessage } from './webhook.js'

/** Handles one accepted WhatsApp message. */
type MessageHandler = (from: string, text: string, id?: string) => Promise<void>

/** Configuration required by the webhook route. */
type WebhookConfig = Pick<Config, 'webhookSecret' | 'allowedNumber'>

/** Duplicate-tracking state for one Evolution message ID. */
type MessageState = 'pending' | 'done'

/** Result of claiming a message ID for processing. */
type MessageClaim = 'claimed' | 'pending' | 'duplicate'

/**
 * Compares the webhook secret without leaking timing information.
 *
 * @param header - Secret received in the `Webhook-Secret` header.
 * @param expected - Secret configured for this bridge.
 * @returns `true` only when both values are present and identical.
 */
function validSecret(header: string | undefined, expected: string): boolean {
  if (!header) return false
  const actual = Buffer.from(header)
  const target = Buffer.from(expected)
  return actual.length === target.length && timingSafeEqual(actual, target)
}

/**
 * Creates middleware that rejects unauthenticated webhook requests before JSON parsing.
 *
 * @param config - Webhook secret.
 * @returns Express middleware for `/webhook`.
 */
function requireSecret(config: WebhookConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!validSecret(request.get('Webhook-Secret'), config.webhookSecret)) {
      response.status(403).json({ error: 'forbidden' })
      return
    }
    next()
  }
}

/**
 * Claims a message ID and reports whether it is new, in flight, or complete.
 *
 * @param seen - Bounded message-state map for this app instance.
 * @param id - Evolution message ID, when available.
 * @returns The claim result.
 */
function claimMessage(seen: Map<string, MessageState>, id: string | undefined): MessageClaim {
  if (!id) return 'claimed'
  const state = seen.get(id)
  if (state === 'done') return 'duplicate'
  if (state === 'pending') return 'pending'
  seen.set(id, 'pending')
  if (seen.size > 500) seen.delete(seen.keys().next().value!)
  return 'claimed'
}

/** Marks a successfully processed message as complete. */
function completeMessage(seen: Map<string, MessageState>, id: string | undefined): void {
  if (id) seen.set(id, 'done')
}

/** Releases a retryable failed message so Evolution can deliver it again. */
function releaseMessage(seen: Map<string, MessageState>, id: string | undefined): void {
  if (id) seen.delete(id)
}

/** Result of validating an Evolution webhook body. */
type WebhookValidation =
  | { incoming: IncomingMessage & { text: string; id: string } }
  | { status: 400 | 403; error: string }
  | { ignored: true }

/** Validates event, JID, allowlist, message shape, and text. */
function validateWebhook(body: unknown, allowedNumber: string): WebhookValidation {
  const payload = body as { event?: unknown; data?: { key?: { remoteJid?: unknown } } } | undefined
  if (payload?.event !== 'messages.upsert') return { ignored: true }
  const remoteJid = payload.data?.key?.remoteJid
  if (typeof remoteJid !== 'string') return { status: 400, error: 'invalid payload' }
  if (!/^(?:\d+(?::\d+)?@s\.whatsapp\.net|\d+@g\.us|\d+@broadcast)$/.test(remoteJid)) {
    return { status: 400, error: 'invalid payload' }
  }
  if (remoteJid.endsWith('@s.whatsapp.net') && normalizeNumber(remoteJid) !== allowedNumber) {
    return { status: 403, error: 'forbidden' }
  }
  const incoming = extractIncoming(body)
  if (!incoming || !incoming.text?.trim()) return { ignored: true }
  if (!incoming.id?.trim()) return { status: 400, error: 'missing message id' }
  return { incoming: incoming as IncomingMessage & { text: string; id: string } }
}

/**
 * Creates the Express handler for `POST /webhook` after authentication and parsing.
 *
 * @param config - Allowed phone number.
 * @param handleMessage - Runtime callback for accepted messages.
 * @param seen - Shared duplicate-tracking map for this app instance.
 * @returns An async Express route handler.
 */
function webhookHandler(config: WebhookConfig, handleMessage: MessageHandler, seen: Map<string, MessageState>) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const validation = validateWebhook(request.body, config.allowedNumber)
      if ('ignored' in validation) {
        response.json({ ignored: true })
        return
      }
      if ('status' in validation) {
        response.status(validation.status).json({ error: validation.error })
        return
      }
      const incoming = validation.incoming
      const claim = claimMessage(seen, incoming.id)
      if (claim === 'duplicate') {
        response.json({ duplicate: true })
        return
      }
      if (claim === 'pending') {
        response.status(409).json({ in_progress: true })
        return
      }

      try {
        await handleMessage(incoming.from, incoming.text, incoming.id)
      } catch (error) {
        const retryable = (error as { retryable?: boolean }).retryable === true
        const busy = (error as { statusCode?: number }).statusCode === 429
        if (retryable || busy) releaseMessage(seen, incoming.id)
        else completeMessage(seen, incoming.id)
        throw error
      }
      completeMessage(seen, incoming.id)
      response.json({ ok: true })
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Converts parser, queue, and unexpected failures into stable JSON responses.
 *
 * @param error - Error forwarded by Express.
 * @param _request - Current HTTP request.
 * @param response - Current HTTP response.
 * @param _next - Unused Express continuation callback.
 */
const errorHandler: ErrorRequestHandler = (error: unknown, _request: Request, response: Response, _next) => {
  const type = (error as { type?: string }).type
  const statusCode = (error as { statusCode?: number }).statusCode
  if (statusCode === 429) {
    response.status(429).json({ error: 'busy' })
    return
  }
  if (type === 'entity.parse.failed') {
    response.status(400).json({ error: 'invalid json' })
    return
  }
  if (type === 'entity.too.large') {
    response.status(413).json({ error: 'payload too large' })
    return
  }
  console.error('Webhook failed.', error)
  response.status(500).json({ error: 'internal error' })
}

/**
 * Builds the zapcode Express application.
 *
 * @param config - Webhook secret and allowed phone number.
 * @param handleMessage - Runtime callback for accepted messages.
 * @returns Configured Express app with `/health` and `/webhook`.
 */
export function createApp(config: WebhookConfig, handleMessage: MessageHandler) {
  /** Express application that owns the route and middleware stack. */
  const app = express()
  // shortcut: dedup is memory-only; move to SQLite if retries after restarts become a problem.
  /** Recently processed message IDs and their completion state. */
  const seen = new Map<string, MessageState>()

  app.get('/health', (_request, response) => response.json({ status: 'ok' }))
  app.post(
    '/webhook',
    requireSecret(config),
    express.json({ limit: '100kb' }),
    webhookHandler(config, handleMessage, seen),
  )
  app.use(errorHandler)
  return app
}
