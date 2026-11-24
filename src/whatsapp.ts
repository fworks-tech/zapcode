/**
 * WhatsApp text delivery through Evolution API.
 *
 * @remarks
 * Responses are split into ordered chunks that respect WhatsApp-sized limits
 * while preserving words and Unicode surrogate pairs whenever possible.
 */

/** Evolution settings required to send WhatsApp text messages. */
interface WhatsAppConfig {
  /** Base URL of the Evolution API. */
  evolutionUrl: string
  /** API key sent in the `apikey` request header. */
  evolutionApiKey: string
  /** Evolution instance that owns the WhatsApp connection. */
  evolutionInstance: string
}

/**
 * Splits text into ordered chunks without losing content.
 *
 * @param text - Full response text.
 * @param limit - Maximum JavaScript string length per chunk.
 * @returns One or more chunks whose concatenation equals the input.
 * @throws When `limit` is less than one.
 */
export function chunkText(text: string, limit = 3500): string[] {
  if (limit < 1) throw new Error('Chunk limit must be greater than zero.')
  if (text.length <= limit) return [text]

  /** Completed chunks in delivery order. */
  const chunks: string[] = []
  /** Start offset of the chunk currently being built. */
  let start = 0
  while (start < text.length) {
    /** Candidate end offset for the current chunk. */
    let end = Math.min(start + limit, text.length)
    if (end < text.length) {
      /** UTF-16 code unit immediately before the candidate boundary. */
      const previous = text.charCodeAt(end - 1)
      /** UTF-16 code unit immediately after the candidate boundary. */
      const next = text.charCodeAt(end)
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
      if (end === start) end = Math.min(start + 2, text.length)

      /** Preferred newline boundary at or before the candidate end. */
      const newline = text.lastIndexOf('\n', end - 1)
      /** Fallback space boundary at or before the candidate end. */
      const space = text.lastIndexOf(' ', end - 1)
      if (newline >= start) end = newline + 1
      else if (space >= start) end = space + 1
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

/**
 * Sends one text message through Evolution's `sendText` endpoint.
 *
 * @param config - Evolution connection settings.
 * @param to - Destination phone number.
 * @param text - Message content.
 * @param fetchImpl - Fetch implementation, injectable for tests.
 * @throws When Evolution returns a non-success HTTP status.
 */
export async function sendText(
  config: WhatsAppConfig,
  to: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  /** Instance-specific Evolution message endpoint. */
  const url = `${config.evolutionUrl}/message/sendText/${encodeURIComponent(config.evolutionInstance)}`
  /** HTTP response returned by Evolution. */
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.evolutionApiKey },
    body: JSON.stringify({ number: to, textMessage: { text } }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    /** Bounded error body included in the thrown exception. */
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`Evolution responded with ${response.status}: ${detail}`)
  }
}
