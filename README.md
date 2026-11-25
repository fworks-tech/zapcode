# zapcode

Single-user bridge between **unofficial WhatsApp** and **OpenCode**. Send a message from your phone, let Evolution API deliver it to the bridge, and get an OpenCode response backed by a local `knowledge/` base.

Portfolio project: no Meta Cloud API, no dashboard, no bridge database, and explicit approval for dangerous tools directly from WhatsApp.

## Architecture

```text
WhatsApp ↔ Evolution API (Baileys + QR) ↔ POST /webhook ↔ zapcode (Express)
                                                           ↓
                                            OpenCode API + knowledge/*.md
                                                           ↓
                                            chunked response ↔ WhatsApp
```

- **Evolution API v2.3.7**: unofficial Docker gateway backed by PostgreSQL and Redis.
- **zapcode**: validates the secret and phone number, maintains one OpenCode session, injects knowledge, and sends the response.
- **OpenCode V2**: runs the agent in `WORKDIR`; the bridge waits for execution and reads the newest assistant message.
- **Cloudflare Tunnel**: makes the local webhook reachable by Evolution. The bridge and Evolution ports stay on `127.0.0.1`.

## Requirements

- Node.js 22+
- Docker Desktop with the daemon running
- OpenCode V2 installed with a configured provider/model
- `cloudflared` installed for the tunnel
- A WhatsApp number to link through QR code (prefer a secondary number)

`ALLOWED_NUMBER` is your personal number that **sends** messages; the number linked to Evolution is the one that **receives** them. To avoid ambiguity during testing, use a secondary number in Evolution.

The LLM is the only variable cost. For zero cost, configure a local model in OpenCode, such as Ollama.

## Run locally

### 1. Configure

In PowerShell, from the repository folder:

```powershell
Copy-Item .env.example .env
npm install
```

Edit `.env` and replace every placeholder. Set `WORKDIR` to the absolute project directory OpenCode should edit. Send `/reset` before changing `WORKDIR`; the bridge fails closed when a saved session belongs to another project. Generate different secrets for `OPENCODE_PASSWORD`, `EVOLUTION_API_KEY`, `WEBHOOK_SECRET`, and `POSTGRES_PASSWORD`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`ALLOWED_NUMBER` must contain only the country code, area code, and number, for example `5511999999999`.

### 2. Start Evolution

```powershell
docker compose up -d
docker compose logs -f evolution-api
```

The API is available at `http://127.0.0.1:8080`. Volumes preserve the WhatsApp link across restarts.

### 3. Start OpenCode

In a separate terminal, run from the repository folder that contains `package.json`:

```powershell
npm run opencode
```

The script loads `.env` and starts `opencode serve` on loopback with `OPENCODE_PASSWORD`. zapcode uses the same password with HTTP Basic auth (username `opencode`). Confirm that the provider/model is configured; zapcode does not choose or store LLM keys.

V1 uses fixed OpenCode port 4096. If you change it, update both `OPENCODE_URL` and the `opencode` npm script.

### 4. Start the bridge

```powershell
npm run dev
```

Check it locally:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

Examples assume the default bridge port 3000. If you change `PORT`, use that port in the health check and tunnel command.

### 5. Open the tunnel

In another terminal:

```powershell
cloudflared tunnel --url http://127.0.0.1:3000
```

Copy the `https://...trycloudflare.com` URL. The quick tunnel exposes `/health` and `/webhook`; `/health` is public, while `/webhook` requires its secret.

### 6. Create the instance and configure the webhook

In PowerShell, replace `$key`, `$secret`, `$instance`, and `$publicUrl` with your values:

```powershell
$api = "http://127.0.0.1:8080"
$key = "PASTE_EVOLUTION_API_KEY"
$secret = "PASTE_WEBHOOK_SECRET"
$instance = "zapcode"
$publicUrl = "https://YOUR-URL.trycloudflare.com"
$headers = @{ apikey = $key }

$create = @{
  instanceName = $instance
  integration = "WHATSAPP-BAILEYS"
  qrcode = $true
} | ConvertTo-Json

Invoke-RestMethod -Uri "$api/instance/create" -Method Post -Headers $headers -ContentType "application/json" -Body $create

$webhook = @{
  enabled = $true
  url = "$publicUrl/webhook"
  byEvents = $false
  base64 = $false
  events = @("MESSAGES_UPSERT")
  headers = @{ "Webhook-Secret" = $secret }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "$api/webhook/set/$instance" -Method Post -Headers $headers -ContentType "application/json" -Body (@{ webhook = $webhook } | ConvertTo-Json -Depth 5)
```

Avoid leaving literal secrets in PowerShell history. Prefer loading them from a protected local secret store or an environment prompt that does not echo the value.

### 7. Link WhatsApp

```powershell
$api = "http://127.0.0.1:8080"
$key = "PASTE_EVOLUTION_API_KEY"
$instance = "zapcode"
$headers = @{ apikey = $key }
$qr = Invoke-RestMethod -Uri "$api/instance/connect/$instance" -Method Get -Headers $headers
New-Item -ItemType Directory -Force data | Out-Null
$base64 = ($qr.base64 -split ',', 2)[1]
if ($base64) {
  [IO.File]::WriteAllBytes("$PWD\data\qrcode.png", [Convert]::FromBase64String($base64))
  Write-Host "Open data\qrcode.png and scan it in WhatsApp: Linked devices > Link a device."
} else {
  $qr | ConvertTo-Json -Depth 5
}
```

If the QR code expires, call `instance/connect/$instance` again. To check the connection:

```powershell
Invoke-RestMethod -Uri "$api/instance/connectionState/$instance" -Method Get -Headers $headers
```

## Commands

| Command | Effect |
| --- | --- |
| `/help` | Shows the available commands. |
| `/reset` | Invalidates current work, cancels the active or recovered inbox item, rejects server-side permissions, removes the OpenCode session, and deletes the local session file. Success is sent only after cleanup is confirmed. |
| `/yes <id>` | Grants one permission **once**, but only after the complete request has been delivered. The ID may be omitted when exactly one request is pending. |
| `/no <id>` | Rejects every pending request in the same session. The ID may be omitted when exactly one request is pending. |

When OpenCode requests a tool, zapcode sends the complete action and resource through WhatsApp, splitting long requests into ordered chunks with bounded retries. `/yes` is refused until every chunk is delivered. Approval commands share the reset queue so they cannot race session cleanup.

New sessions use conservative rules:

- `glob` is allowed;
- `read`, `edit`, `shell`, and other tools require approval;
- reads/edits of `.env*` are denied; external directories, interactive questions, grep, and subagents are also denied;
- reused sessions are validated and refreshed with the current rules;
- durable project approvals are removed before prompts and reset so they cannot bypass WhatsApp approval;
- pending requests denied by the current policy are rejected instead of shown.

Approved shell commands can still access files and secrets. The permission bridge reduces accidental exposure; it is not a sandbox.

## Queue, timeout, and retry behavior

- One prompt runs at a time, with at most one additional prompt waiting.
- A third waiting turn receives HTTP 429 from the webhook.
- The 55-second execution deadline starts after queue wait, session setup, and knowledge loading.
- Reset waits up to 12 seconds for the active run and uses a 5-second cancellation deadline.
- Failed cancellation keeps the run tracked and blocks new prompts until another `/reset` succeeds.
- Response chunks have bounded retries. A failed chunk stops the remaining chunks and reports the failure.
- Supported text payloads require a non-empty Evolution message ID. IDs are tracked as pending or complete; transient pre-admission failures are retryable, while deterministic setup/state failures and post-admission failures stay deduplicated.
- Known pre-admission rejections never interrupt an OpenCode session. Cancellation runs only after admission is confirmed or the server response is uncertain.

## Knowledge base

Edit `knowledge/faq.md` or add other `.md` files. The bridge reads every Markdown file for each question and injects the content as trusted context. Files are loaded alphabetically.

The knowledge base is limited to 20 files and 24,000 total characters. A UTF-8 byte-size preflight can reject multibyte content earlier. The session and active-run bookkeeping are stored in `data/session.json`.

## Development and tests

```powershell
npm test
npm run typecheck
```

Tests cover the allowlist, secret validation, strict JIDs, deduplication and retries, queue backpressure, commands, reset races, restart recovery, permission scope and display, `.env` policy, persistence, knowledge limits, response extraction, inbox cancellation, Basic auth, the generated OpenCode HTTP contract, and the Evolution `textMessage` contract.

Automated tests mock external services. Real OpenCode permission matching and the complete WhatsApp/QR/tunnel flow still require manual validation. All TypeScript source and test files include TSDoc for modules, declarations, and non-obvious local state.

## Limitations and risks

- The unofficial API may disconnect, break after WhatsApp updates, or lead to a number ban. Prefer a secondary number for testing.
- V1 requires the PC, OpenCode, and tunnel to stay active.
- LLM tokens cost according to the provider; a local model avoids that cost but requires hardware.
- Deduplication is in memory and keeps 500 IDs. Restarting the bridge or evicting an old ID may allow a very old retry to be processed again.
- Invalid `data/session.json` fails closed. Back up or remove the file before retrying; the bridge will not silently overwrite corrupted state.
- The quick tunnel has no fixed URL; update the Evolution webhook after restarting it.
- Evolution's webhook transport timeout is 120 seconds. Queue wait, model execution, and WhatsApp delivery can share that window.
- V1 has no audio, images, stickers, groups, multi-user support, simultaneous multi-project support, or distributed queue.

## Phase 2: cloud

Move Evolution and the bridge to a VPS, preserve the volumes, use a fixed URL, and store secrets in the VPS environment. The flow and modules can stay the same. History needs additional persistence; multi-number support also needs per-number session, queue, and permission state.

## Contributing

Create a branch, follow the local style (TypeScript, single quotes, no semicolons), and use Conventional Commits. Before opening a PR, follow the full pre-push checklist in `AGENTS.md`: tests, typecheck, strict unused check, `npm audit`, and Compose config validation. Never commit `.env*` other than `.env.example`. Also never commit `data/`, logs, credentials, or QR images.

## References

- [OpenCode Client V2](https://opencode.ai/docs/build/client)
- [OpenCode Web/auth V2](https://opencode.ai/docs/cli/web)
- [OpenCode API V2](https://opencode.ai/docs/api)
- [OpenCode V2 permissions](https://opencode.ai/docs/permissions)
- [Evolution: Docker](https://docs.evolutionfoundation.com.br/en/evolution-api/install/docker)
- [Evolution: send text](https://docs.evolutionfoundation.com.br/en/evolution-api/send-text-message)
- [Evolution: webhooks](https://docs.evolutionfoundation.com.br/en/evolution-api/configuration/webhooks)
