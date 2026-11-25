/**
 * Shared runtime test fixtures.
 *
 * @remarks
 * Centralizes configuration, session/permission doubles, deferred promises, and
 * WhatsApp fetch capture so lifecycle tests use the same fake boundaries.
 */

import path from 'node:path'

import type { Config } from '../../src/config.js'
import { createMessageRuntime } from '../../src/runtime.js'
import { webhookConfig } from './webhook.js'

export { webhookConfig }

/** Complete runtime configuration used by lifecycle tests. */
export const runtimeConfig: Config = {
  openCodeUrl: 'http://127.0.0.1:4096',
  openCodePassword: 'opencode-password-with-32-characters',
  workdir: process.cwd(),
  knowledgeDir: path.join(process.cwd(), 'knowledge'),
  sessionFile: path.join(process.cwd(), 'data', 'session.json'),
  evolutionUrl: 'http://evolution',
  evolutionApiKey: 'api-key',
  evolutionInstance: 'zapcode',
  allowedNumber: webhookConfig.allowedNumber,
  webhookSecret: 'webhook-secret-with-32-characters',
  port: 3000,
}

/** Runtime boundary overrides for a specific test. */
export interface RuntimeHarnessOverrides {
  client?: Record<string, unknown>
  sessions?: Record<string, unknown>
  permissions?: Record<string, unknown>
}

/**
 * Creates a manually controlled promise.
 *
 * @returns The pending promise and its resolver.
 */
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/**
 * Builds a runtime with shared defaults and captures WhatsApp output.
 *
 * @param overrides - Boundary behavior that differs from the defaults.
 * @returns Runtime, sent messages, and a fetch restoration function.
 */
export function createRuntimeHarness(overrides: RuntimeHarnessOverrides = {}) {
  const sent: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    if (init?.body) {
      const body = JSON.parse(String(init.body))
      sent.push(body.textMessage.text)
    }
    return Response.json({})
  }

  const sessions = {
    ensure: async () => 'session-1',
    reset: async () => undefined,
    currentSessionID: async () => 'session-1',
    getActiveRun: async () => undefined,
    markActive: async () => undefined,
    clearActive: async () => undefined,
    ...overrides.sessions,
  }
  const permissions = {
    clear: async () => undefined,
    decide: async () => null,
    setActiveSession: () => undefined,
    reconcile: async () => undefined,
    ...overrides.permissions,
  }
  const runtime = createMessageRuntime({
    config: runtimeConfig,
    client: (overrides.client ?? { session: {} }) as never,
    sessions: sessions as never,
    permissions: permissions as never,
  })
  return { runtime, sent, restore: () => { globalThis.fetch = originalFetch } }
}
