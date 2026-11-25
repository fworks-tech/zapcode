# ADR 004: Use a fixed password and Basic auth for local OpenCode

**Date:** 2026-11-24
**Status:** Accepted (v1)

## Context

`opencode serve` V2 requires authentication even on loopback. A client without credentials receives 401. The bridge and server must share a password without exposing OpenCode outside the machine.

## Decision

Set `OPENCODE_PASSWORD` in `.env`. `npm run opencode` loads it when starting the server from the repository folder, and `createOpenCode` sends HTTP Basic auth with username `opencode`.

## Alternatives

- Trust loopback without authentication: not supported by the V2 server.
- Discover the shared service with `Service.ensure()`: avoids a fixed password, but ties zapcode to the global service instead of the planned foreground server.
- Expose the server without a password over the network: rejected for security.

## Consequences

The bridge targets the generated V2 client contract, and the password stays out of source control. Real-server validation remains a manual check. The user must configure the same value in `.env`; the npm script prevents manual duplication. The password must not be shared or committed.
