# zapcode — How it works (local v1)

## Components

- `whatsapp`: Evolution API v2.3.7 in Docker (Baileys, QR), PostgreSQL, and Redis. Transport only.
- `bridge`: Node + TypeScript + Express. Validates the number and secret, manages the session, calls OpenCode, and forwards the response.
- `brain`: local OpenCode V2 through `@opencode/client`, using HTTP Basic auth with `OPENCODE_PASSWORD`.
- `knowledge/*.md`: knowledge base loaded for every prompt and injected as context.
- `tunnel`: Cloudflare quick tunnel to the loopback bridge. Evolution sends the secret header configured in the webhook.

## Flow

1. WhatsApp → Evolution → `POST /webhook`. Secret validation runs before JSON parsing.
2. The bridge validates the JID shape, requires a non-empty message ID for supported text, ignores unsupported events, and blocks unauthorized direct senders.
3. Message IDs move through pending and completed states. Transient pre-admission failures release the ID; deterministic setup/state failures and post-admission failures stay deduplicated.
4. `SessionStore.ensure()` validates the saved session and workdir, refreshes its permissions, or creates a new session for `WORKDIR`. A mismatched workdir fails closed until `/reset` removes the old session.
5. The runtime persists the active inbox ID, loads `knowledge/*.md`, calls `session.prompt`, waits on `experimental.session.wait`, and reads `message.list`.
6. It extracts only the newest assistant response, splits it into chunks, and sends them in order through Evolution with bounded retries.
7. `/reset` invalidates the generation, aborts and awaits the run, reconciles and rejects server permissions, deactivates permission events before removing the OpenCode session, and deletes the local file. Failed removal restores permission routing.
8. Permission events are scoped to the active session and workdir. Durable project approvals are removed, policy-denied requests are rejected with bounded retries, and complete allowed requests are sent in ordered WhatsApp chunks with bounded retries. `/yes` requires every chunk, and `/yes`/`/no` share the reset queue.
9. Timeout/reset use the stable prompt ID. Cancellation is confirmed through inbox cancellation, interruption, and active/inbox checks when needed.
10. Shutdown starts HTTP close and runtime cancellation concurrently; exit waits for both, with a 30-second fallback.

## Data and configuration

- `data/session.json`: `{ "sessionID": "...", "workdir": "...", "activeRun": { "inboxID": "..." } }`. Writes are serialized and atomic; malformed state fails closed instead of being overwritten.
- `.env`: `OPENCODE_URL, OPENCODE_PASSWORD, WORKDIR, EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE, ALLOWED_NUMBER, WEBHOOK_SECRET, POSTGRES_PASSWORD, PORT`.
- `POSTGRES_PASSWORD` is Compose-only; `PORT` is optional and defaults to 3000.
- Message content is not stored in the Evolution database (`DATABASE_SAVE_DATA_NEW_MESSAGE=false`).
- The bridge has no database.

## Phase 2 (cloud, not detailed yet)

Run the same bridge and Evolution on a VPS with persistent storage; replace the tunnel with a fixed URL and manage secrets through the VPS environment.
