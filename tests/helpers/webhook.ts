/**
 * Shared webhook test fixtures.
 *
 * @remarks
 * Keeps secret, allowlist, Evolution settings, and payload shape identical
 * across HTTP and reliability tests.
 */

/** Webhook settings shared by HTTP tests. */
export const webhookConfig = {
  webhookSecret: 'secret',
  allowedNumber: '5511999999999',
}

/** Evolution settings used by sendText tests. */
export const evolutionConfig = {
  ...webhookConfig,
  evolutionUrl: 'http://localhost:8080',
  evolutionApiKey: 'api-key',
  evolutionInstance: 'zapcode',
}

/**
 * Builds a valid direct-message payload.
 *
 * @param id - Evolution message ID.
 * @param remoteJid - Sender JID.
 * @returns A fresh payload that tests may mutate.
 */
export function payload(id = 'message-1', remoteJid = '5511999999999@s.whatsapp.net') {
  return {
    event: 'messages.upsert',
    instance: 'zapcode',
    data: {
      key: { id, remoteJid, fromMe: false },
      message: { conversation: 'Hello' } as Record<string, unknown>,
    },
  }
}
