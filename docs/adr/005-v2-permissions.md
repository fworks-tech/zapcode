# ADR 005: Enforce V2 permissions and show complete approval requests

**Date:** 2026-11-24
**Status:** Accepted (v1)

## Context

Review found that broad read access could expose secrets, reused sessions could keep obsolete rules, permission prompts could hide command tails, and local permission state could drift from the server.

## Decision

- Require approval for broad reads, edits, shell, and other tools; allow glob.
- Deny reads/edits of `.env*`. Also deny external directories, interactive questions, grep, and subagents.
- Place specific denies after broad rules because V2 uses the last match.
- Validate reused sessions and reapply `SAFE_PERMISSIONS` with `session.update`.
- Remove durable project-scoped saved approvals before prompts and reset so they cannot override WhatsApp approval.
- Reject pending requests that current policy denies instead of displaying or approving them.
- Scope live permission events to the active session and require a matching workdir location.
- Show complete resources in ordered WhatsApp chunks with bounded retries, and refuse `/yes` until every chunk is delivered.
- Reconcile the local permission map with the server before reset, reject every known request explicitly, preserve local requests when the server list is unavailable, and await late-event rejections before reset completes.
- Serialize permission decisions with reset.

## Alternatives

- Allow broad reads: rejected because credential files are not limited to `.env*`.
- Trust old session permissions: rejected because policy fixes would not reach existing sessions.
- Truncate long resources: rejected because the owner could approve hidden command tails.
- Keep additive local permission state: rejected because missed events leave stale or missing requests.

## Consequences

The approval boundary is stricter and reset matches server state. The tradeoff is more approval prompts and the fact that approved shell commands still have host access; the bridge is not a sandbox.
