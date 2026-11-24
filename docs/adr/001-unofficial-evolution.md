# ADR 001: Use unofficial Evolution instead of the official Cloud API

**Date:** 2026-11-24
**Status:** Accepted (v1)

## Context

We need to send and receive WhatsApp messages at zero cost and demonstrate a bot built outside the official API, both as an interview topic and a portfolio piece.

## Decision

Self-host Evolution API v2.3.7 (Baileys, QR) in local Docker with PostgreSQL 15.20, Redis 7.4.12, and a persistent instance volume.

## Alternatives

- Official Cloud API: stable and supported, but requires Meta approval, a number/BSP, and per-message fees. Rejected for v1 because of cost and the portfolio goal.
- Raw Baileys in the bridge: no extra container, but we would have to manage sockets, reconnects, and QR handling ourselves. Rejected to avoid maintaining more custom code.

## Consequences

We gain fast QR setup and a ready API, but lose stability (disconnects, WhatsApp update breakage, and ban risk) and require two supporting services. Mitigation: Docker persistence, explicit README limitations, and a secondary number for single-user testing when possible.
