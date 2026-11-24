# ADR 003: Use a local tunnel in v1 and defer VPS deployment to phase 2

**Date:** 2026-11-24
**Status:** Accepted (v1)

## Context

Evolution must reach the bridge webhook. We want zero infrastructure cost, and the initial code runs on a local PC.

## Decision

Run everything locally with the bridge and Evolution on loopback, and use a Cloudflare quick tunnel to the bridge. Evolution sends `Webhook-Secret`; the bridge validates it before parsing JSON.

## Alternatives

- VPS in v1: provides 24/7 uptime and a fixed URL, but adds cost, remote QR setup, and deployment before validation. Deferred to phase 2.
- Open a router port: simple, but exposes the home network. Rejected for security.
- Inject the header through cloudflared: requires extra tunnel configuration. Evolution already supports custom webhook headers, so this was rejected as unnecessary.

## Consequences

We gain zero cost and fast iteration, but lose availability and a fixed URL. The quick tunnel exposes public `/health` and secret-protected `/webhook`; unauthenticated bodies are rejected before parsing. Mitigation: clear delivery-failure logs and README tunnel instructions.
