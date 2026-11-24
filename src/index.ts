/**
 * zapcode process entry point.
 *
 * @remarks
 * The entry point loads configuration, constructs the OpenCode, session,
 * permission, and WhatsApp adapters, then starts the loopback HTTP server.
 * Shutdown cancels active OpenCode work before the process exits.
 */

import 'dotenv/config'

import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createOpenCode } from './opencode.js'
import { PermissionBridge } from './permissions.js'
import { createMessageRuntime } from './runtime.js'
import { SessionStore } from './session.js'
import { sendText } from './whatsapp.js'

/** Initializes all bridge components and blocks until the process exits. */
async function main(): Promise<void> {
  /** Validated environment configuration loaded at startup. */
  const config = loadConfig()
  /** Authenticated OpenCode V2 API client. */
  const client = createOpenCode(config.openCodeUrl, config.openCodePassword)
  /** Persistent single-session store backed by `data/session.json`. */
  const sessions = new SessionStore(client, config.workdir, config.sessionFile)
  /** Streams OpenCode permission events and sends approval prompts to WhatsApp. */
  const permissions = new PermissionBridge(
    client,
    (to, text) => sendText(config, to, text),
    config.allowedNumber,
    config.workdir,
  )
  /** Runtime handler and shutdown operation. */
  const runtime = createMessageRuntime({ config, client, sessions, permissions })

  permissions.start()
  /** Loopback HTTP server exposing `/health` and `/webhook`. */
  const server = createApp(config, runtime.handler).listen(config.port, '127.0.0.1', () => {
    console.info(`zapcode listening on http://127.0.0.1:${config.port}`)
  })

  /** Prevents repeated shutdown handling after the first signal. */
  let stopping = false
  /** Stops permission streaming, cancels OpenCode work, and closes HTTP. */
  const shutdown = () => {
    if (stopping) return
    stopping = true
    permissions.stop()
    let httpClosed = false
    let runtimeClosed = false
    const exitIfStopped = () => {
      if (httpClosed && runtimeClosed) process.exit(0)
    }
    server.close(() => {
      httpClosed = true
      exitIfStopped()
    })
    void runtime.shutdown()
      .catch((error) => console.error('Failed to cancel OpenCode work during shutdown.', error))
      .finally(() => {
        runtimeClosed = true
        exitIfStopped()
      })
    setTimeout(() => process.exit(0), 30_000).unref()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('Failed to start zapcode.', error)
  process.exit(1)
})
