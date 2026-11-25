# zapcode — V1 requirements (local) and phase 2 (cloud)

Date: 2026-11-24. Single owner. Zero infrastructure cost in v1. No official API.

## What v1 solves

Answer questions through WhatsApp using OpenCode and a private `knowledge/` base, only for the owner, running on a local PC with a tunnel.

## Functional requirements

- FR1: Connect WhatsApp through Evolution API v2.3.7 (QR) and persist the session in a volume.
- FR2: Receive `MESSAGES_UPSERT` through `POST /webhook` with a secret validated before JSON parsing; supported text payloads require a non-empty message ID.
- FR3: Respond only to supported direct messages from `ALLOWED_NUMBER`; malformed JIDs return 400 and unauthorized direct senders return 403.
- FR4: Persist one OpenCode session and active-run bookkeeping in `data/session.json`.
- FR5: Create or reuse the session for the fixed `WORKDIR` and prepend `knowledge/*.md` to each prompt.
- FR6: Wait for execution through `experimental.session.wait` and read only the newest assistant response.
- FR7: Return the response in chunks of up to ~3500 characters through Evolution `sendText`.
- FR8: Provide `/reset`, `/help`, `/yes <id>`, and `/no <id>` commands.
- FR9: Approve or reject tools through WhatsApp; approval must not wait behind the prompt that is waiting for permission, and `/yes` requires the complete request to be delivered first.
- FR10: `/no` explicitly rejects every request in the same session and removes only successfully rejected requests locally.
- FR11: `/reset` invalidates the current generation, cancels active or recovered inbox work, reconciles server permissions, removes the OpenCode session, and deletes the local file only after confirmed cleanup.
- FR12: Keep logs minimal: sender, message length, session ID, errors, and chunk count.
- FR13: Bound the normal queue to one active and one waiting turn; return 429 when full.
- FR14: Track webhook IDs as pending or complete. Retry only transient failures known to happen before OpenCode admission; deterministic setup/state failures and post-admission failures stay deduplicated.
- FR15: Surface assistant provider errors instead of returning a successful empty response.

## Non-functional requirements

- NFR1: Zero infrastructure cost: local Docker Evolution + Node bridge + free tunnel.
- NFR2: The webhook requires `WEBHOOK_SECRET`; `/health` is intentionally public.
- NFR3: New and reused sessions enforce conservative permissions: read/edit/shell ask; glob is allowed; reads/edits of `.env*` are denied. External directories, interactive questions, grep, and subagents are also denied. Specific rules follow broad rules because V2 uses the last match. Durable project approvals are removed and pending requests that violate current policy are rejected.
- NFR4: Execution deadline is 55 seconds after setup. Cancellation uses 5 seconds; reset waits up to 12 seconds. Known pre-admission rejections do not interrupt a session; uncertain or admitted work does. Unconfirmed cancellation retains the run and blocks new prompts.
- NFR5: Text only in v1 (no audio, images, stickers, or groups).
- NFR6: Portfolio-ready README with architecture and unofficial API limitations.
- NFR7: Evolution and the bridge listen only on loopback; PostgreSQL and Redis publish no ports.
- NFR8: In-memory message deduplication limited to 500 IDs; supported text payloads without a non-empty ID are rejected.
- NFR9: Evolution does not expose keys through the instance list endpoint and does not store messages, contacts, chats, or history.
- NFR10: OpenCode runs on loopback with a fixed password through `OPENCODE_PASSWORD`; the bridge sends HTTP Basic auth.
- NFR11: Permission notifications show complete resources in ordered chunks and are scoped to the active session and workdir.
- NFR12: Knowledge loading is limited to 20 Markdown files and 24,000 total characters; UTF-8 byte-size preflight may reject multibyte content earlier.
- NFR13: Session and permission control calls use short deadlines so a stalled OpenCode service cannot wedge the bridge.

## Fixed constraints

Single user, one phone number, one `WORKDIR`, PC always on. The LLM is the only variable cost (use Ollama or a free quota).

## Out of scope for v1

Multi-user, multi-project through chat, audio/images, dashboard, distributed queue, multi-user auth, bridge Docker image, and VPS deployment (all phase 2).

## V1 acceptance criteria

1. QR connects and preserves the session after a container restart.
2. A supported direct message from an unauthorized number receives 403 and is ignored.
3. A question about `knowledge/faq.md` gets an answer based on it.
4. `/reset` cancels active or recovered work, rejects server permissions, removes the server session, and deletes local state.
5. A long response arrives in ordered chunks; reset stops chunks that have not started.
6. A tool approval shows the complete resource; `/yes` allows it once and `/no` rejects every request in the session.
7. If the tunnel goes down, the bridge remains healthy locally and logs delivery failures.
8. A missing OpenCode session is recreated instead of bricking prompts and reset.
9. A failed turn never returns an older assistant response.

## Chosen stack

Node 22 + TypeScript + Express 4.22.3 + `@opencode/client` 2.4.1; OpenCode V2 authenticated with Basic auth; Evolution v2.3.7 + PostgreSQL 15.20 + Redis 7.4.12; Cloudflare Tunnel.
