# Frequently asked questions (initial agent knowledge)

> Edit this file with the real questions you want the agent to answer. The bridge injects this content as context for every prompt.

## How do I connect WhatsApp?

Scan the Evolution API QR code. If it expires, request a new one and scan it again.

## Why was my message ignored?

V1 only responds to supported direct text messages from the number in `ALLOWED_NUMBER`. Other direct senders receive 403 and are ignored.

## How do I restart the conversation?

Send `/reset`. The bridge cancels active or recovered work, rejects pending permissions, removes the OpenCode session, and clears the local session file.

## Which tools need approval?

Read, edit, shell, and other tools require approval. Glob is allowed. Reads/edits of `.env*` are denied. External directories, interactive questions, grep, and subagents are also denied.

## Can saved OpenCode approvals bypass WhatsApp?

No. The bridge removes durable project approvals before prompts and reset. Pending requests that violate the current policy are rejected.

## Does an approved shell command run in a sandbox?

No. Approval shows the complete request, but an approved shell command can still access files and secrets on the host.

## Does the bot go offline when I close my PC?

Yes in local v1. The bridge, OpenCode, and Evolution run on your PC with a tunnel. Phase 2 moves them to a VPS.
