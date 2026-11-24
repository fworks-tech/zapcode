# zapcode — Build order (one commit per item)

- [x] docs: review requirements and architecture
- [x] chore: scaffold Node + TypeScript (`package.json`, `tsconfig`, `.gitignore`, `.env.example`)
- [x] feat(evolution): Docker Compose with persistent session volume and QR instructions
- [x] feat(webhook): secret-first `POST /webhook`, strict JID validation, allowlist, and retry-safe dedup
- [x] feat(opencode): validated session reuse, Basic auth, stable prompt IDs, wait, and newest-response extraction
- [x] feat(knowledge): inject `knowledge/*.md` with deterministic ordering and size limits
- [x] feat(whatsapp): chunked sending, bounded retries, and visible errors
- [x] feat(commands): `/reset`, `/help`, `/yes`, and `/no`
- [x] feat(permissions): complete resource display, active-session scope, saved-approval removal, server reconciliation, and explicit rejection
- [x] fix(permissions): last-match ordering, read approval, grep/subagent blocking, and reused-session policy refresh
- [x] fix(opencode): confirmed cancellation, active/inbox verification, and assistant error handling
- [x] fix(runtime): persisted active run, restart recovery, single cancellation owner, and shutdown cancellation
- [x] fix(handler): bounded queue, reset-safe chunk delivery, and serialized permission decisions
- [x] test(regressions): permission display/scope, reset races, stale replies, retries, JIDs, queue, and knowledge limits
- [x] test(contract): generated OpenCode V2 HTTP contract with scripted fetch
- [x] chore(tunnel): Cloudflare Tunnel + secret header in Evolution + README step
- [ ] test(manual): QR → question → long response → approval → reset → blocked number
- [x] docs(portfolio): README, architecture, ADRs, limitations, and cloud plan
- [x] docs: translate documentation and user-facing strings to English
- [x] docs: add TSDoc across source and tests

Phase 2 (do not start now): VPS with persistent storage, fixed URL, VPS-managed secrets, and multi-number support if needed.
