/**
 * Parsing helpers for Evolution `messages.upsert` webhook payloads.
 *
 * @remarks
 * Only direct, incoming text messages are accepted. Groups, broadcasts, own
 * messages, media, and malformed payloads are rejected before authorization.
 */

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value - Untrusted value to inspect.
 * @returns `true` for non-null, non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalized text message extracted from an Evolution payload. */
export interface IncomingMessage {
  /** Digits-only sender phone number. */
  from: string
  /** Message text, or `undefined` for an accepted event without text. */
  text: string | undefined
  /** Evolution message ID used for deduplication. */
  id?: string
}

/**
 * Converts a WhatsApp JID or formatted number into digits only.
 *
 * @param value - JID such as `5511999999999@s.whatsapp.net` or a phone number.
 * @returns Country code, area code, and number without punctuation.
 */
export function normalizeNumber(value: string): string {
  return value.split('@')[0]!.split(':')[0]!.replace(/\D/g, '')
}

/** Returns whether a value is a supported direct WhatsApp JID. */
function isDirectWhatsAppJid(value: string): boolean {
  return /^\d+(?::\d+)?@s\.whatsapp\.net$/.test(value)
}

/** Extracts text from supported Baileys message shapes. */
function extractText(message: unknown): string | undefined | null {
  if (message === undefined) return undefined
  if (isRecord(message) && typeof message.conversation === 'string') return message.conversation
  if (isRecord(message) && isRecord(message.extendedTextMessage) && typeof message.extendedTextMessage.text === 'string') {
    return message.extendedTextMessage.text
  }
  return null
}

/** Returns the direct sender JID for an incoming message key. */
function incomingJid(key: Record<string, unknown>): string | null {
  if (typeof key.remoteJid !== 'string' || key.fromMe === true) return null
  return isDirectWhatsAppJid(key.remoteJid) ? key.remoteJid : null
}

/**
 * Extracts a supported incoming message from an Evolution webhook body.
 *
 * @param body - Parsed JSON payload from Evolution.
 * @returns A normalized message, or `null` when the event is unsupported.
 */
export function extractIncoming(body: unknown): IncomingMessage | null {
  if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.key)) return null
  const key = body.data.key
  const remoteJid = incomingJid(key)
  if (!remoteJid) return null
  const text = extractText(body.data.message)
  if (text === null) return null

  return {
    from: normalizeNumber(remoteJid),
    text,
    ...(typeof key.id === 'string' ? { id: key.id } : {}),
  }
}
