# AGENTS.md

zapcode is a single-user, local bridge between unofficial WhatsApp and one OpenCode V2 session. V1 supports one owner, one number, one `WORKDIR`, text only, and one bridge process.

## Commands

- Requires Node.js 22+, Docker Desktop, OpenCode V2, and `cloudflared`.
- PowerShell setup: `Copy-Item .env.example .env`, replace every placeholder, then `npm install`.
- Core verification: `npm test && npm run typecheck`.
- Strict unused check: `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`.
- Focused test: `npx tsx --test tests/webhook.test.ts`; `npm test` auto-discovers `tests/*.test.ts`.
- No lint, formatter, build, repo hooks, or `npm start` script exists. CI runs `npm ci`, `npm test`, and `npm run typecheck` on pull requests and pushes to `master`. Run the TypeScript bridge with `npm run dev`.
- Runtime order, each in its own terminal: `docker compose up -d` → `npm run opencode` → `npm run dev` → `cloudflared tunnel --url http://127.0.0.1:3000`. Then follow README steps 6–7 to create the Evolution instance, configure `/webhook`, and link WhatsApp.
- `npm run opencode` must run from the repository root. It loads `.env` and serves OpenCode V2 on `127.0.0.1:4096`; changing that port requires changing both `OPENCODE_URL` and the npm script. If `PORT` changes, update health checks and the tunnel URL too.

## Architecture

- `src/index.ts` wires the app and owns signals, HTTP close, and the 30-second shutdown fallback.
- `src/app.ts` is the HTTP boundary; `src/handler.ts` owns commands, the bounded queue, response-delivery generation, and chunk retries.
- `src/runtime.ts` owns execution generation, prompt lifecycle, reset, recovery, cancellation, and shutdown admission blocking.
- `src/opencode.ts` uses generated `@opencode/client` 2.4.1 with Basic auth username `opencode`. Snapshot the previous newest assistant ID; after `experimental.session.wait`, never return that old message as the new answer.
- `src/session.ts` persists `{ sessionID, workdir, activeRun? }` in ignored `data/session.json`. The active inbox ID is saved before prompt admission so reset can recover work after restart.
- `src/retry.ts` owns shared bounded retry/backoff. `src/permission-policy.ts` centralizes permission rules and matching helpers; `src/permission-actions.ts` owns notification delivery, server replies, pending-list reads, and cleanup tracking; `src/permission-stream.ts` owns reconnection; `src/permissions.ts` tracks pending decisions. `src/whatsapp.ts` sends Evolution `textMessage` requests.
- `knowledge/*.md` is trusted prompt context, loaded alphabetically for every prompt, limited to 20 files and 24,000 total characters. UTF-8 byte preflight may reject multibyte content earlier. Never put secrets or untrusted instructions there.

## Invariants that are easy to break

- Webhook auth runs before `express.json()`. Keep strict direct-JID validation, the phone allowlist, and the pending/done dedup state machine.
- Supported text payloads require a non-empty Evolution message ID. Dedup is memory-only, keeps 500 IDs, and very old retries after eviction or restart can run again.
- Retry only transient failures known to happen before OpenCode admission. Deterministic setup/state failures and post-admission failures stay deduplicated.
- Normal queue allows one active and one waiting turn; the third receives HTTP 429. `/yes` and `/no` share the reset queue, not the prompt queue.
- Every prompt uses a stable `msg_<uuid>` inbox ID. Execution deadline is 55 seconds after setup. Cancel only when admission is confirmed or uncertain; known pre-admission rejections must not interrupt a session.
- Timeout/reset cancellation confirms inbox cancellation and interruption; check active/inbox state when `interrupted` is false. Unconfirmed cancellation retains the run and blocks new prompts.
- `/reset` invalidates execution and delivery generations, aborts and awaits stale work, reconciles server permissions, deactivates permission events before server session removal, then deletes local state. Restore permission routing if removal fails. Never send success before cleanup is confirmed.
- OpenCode V2 uses last-rule-wins. Keep broad rules before specific denies. `read`/`edit`/`shell` ask; `glob` allows; `read`/`edit` of `.env*`, `external_directory`, `question`, `grep`, and `subagents` deny.
- Approved shell commands are not sandboxed and can read secrets or external paths. Never truncate approval resources; `/yes` requires every notification chunk to be delivered.
- Remove durable project approvals before prompts/reset. Scope permission events to the active session and require the configured workdir location.
- A saved session with a different local or server workdir fails closed. Invalid `data/session.json` also fails closed; back up or remove it before retrying. Send `/reset` before changing `WORKDIR`.
- Treat declared OpenCode `*NotFoundError` names as 404; the generated client may not expose `status`.

## Environment and operations

- Required bridge variables are in `.env.example`; `POSTGRES_PASSWORD` is Compose-only and `PORT` defaults to 3000.
- `ALLOWED_NUMBER` is the personal number that sends messages. The Evolution-linked number receives them.
- Evolution listens on `127.0.0.1:8080`; PostgreSQL and Redis publish no host ports. The webhook transport timeout is 120 seconds.
- Quick-tunnel URLs change on restart, so update the Evolution webhook. Use a secondary WhatsApp number; the unofficial API can disconnect or ban accounts.
- Never commit `.env*` other than `.env.example`. Also never commit `data/`, logs, credentials, or QR images.

## Tests and conventions

- `npm test` needs no Docker, WhatsApp, OpenCode server, or LLM; external boundaries are mocked.
- `tests/opencode-contract.test.ts` uses the real generated client with scripted `fetch`. Runtime fixtures live in `tests/helpers/runtime.ts`; keep regressions in focused `tests/*-regressions.test.ts` files.
- Real OpenCode permission matching plus QR/tunnel/WhatsApp/LLM behavior remain manual end-to-end checks.
- Match local style: TypeScript, single quotes, no semicolons. Keep TSDoc on modules, declarations, and non-obvious lifecycle state.
- Use Conventional Commits. Before push, run `npm test`, `npm run typecheck`, the strict unused check, `npm audit`, and `docker compose --env-file .env.example config --quiet`.
