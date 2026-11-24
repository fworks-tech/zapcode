# ADR 002: Store one session and active run in a file without a database

**Date:** 2026-11-24
**Status:** Accepted (v1)

## Context

The app serves one owner, one phone number, and one `WORKDIR`. We need to preserve the OpenCode session and recover active work after a bridge restart with the fewest moving parts.

## Decision

Store `{ sessionID, workdir, activeRun? }` in `data/session.json`. The bridge validates reused sessions, refreshes their permissions, and persists the active inbox ID before prompt admission. Reset cancels active or recovered work, rejects server-side permissions, removes the OpenCode session, and only then deletes the file.

## Alternatives

- SQLite/Postgres: robust for multi-user history, but adds migrations, schema, and backups for one user. Rejected for v1.
- Memory only: simpler, but loses the session and active-run recovery state on every restart. Rejected.

## Consequences

We gain simplicity and restart recovery, but still lose multi-process concurrency and history after reset. Phase 2 can replace this with a `sessions(number, sessionID, workdir, active_inbox_id)` table without changing the flow.
