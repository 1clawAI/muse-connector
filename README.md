# 1Claw Muse Connector

The 1Claw connector for [Meta Muse](https://muse.ai). Muse users get their AI agents'
approval queue, wallets and activity inside Muse — "is anything waiting on me?",
"approve that", "what did my agents do today?" — while 1Claw keeps every credential,
guardrail and audit trail exactly where it was.

Muse builds **Custom Connectors** by [retrieving a service's API information and storing the
user's credential in its Secure Credentials Store](https://www.meta.com/help/artificial-intelligence/1687253048996149/).
This package is that API: a small, plain-spoken REST surface (`/openapi.json`, `/llms.txt`) in
front of the [1Claw Platform API](https://docs.1claw.co/docs/platform-api/overview), plus the
link flow that turns a signed-in 1Claw user into a scoped, revocable connector token.

```
Muse ──(mcn_ token)──▶ muse.1claw.co ──(plt_ key + connection id)──▶ api.1claw.co
                      this service                                   1Claw vault
```

## What a Muse user can do

| Ask Muse | Route | Notes |
|---|---|---|
| "Is anything waiting on me?" | `GET /v1/approvals` | Both queues (consensus + agent action approvals), one shape |
| "Approve that" / "No, reject it" | `POST /v1/approvals/{id}/decide` | The only write. Consensus votes echo the `payload_hash` the connector read, never one Muse supplies |
| "How much is in my agents' wallets?" | `GET /v1/portfolio`, `GET /v1/balances` | Only wallets on agents the user granted to Muse |
| "What did my agents do today?" | `GET /v1/activity` | Delegation log for the connection |
| "What jobs do they run?" | `GET /v1/automations` | Read only |
| "Which account is this?" | `GET /v1/me` | Connection + granted resources |

Not possible through this connector, by design: reading secrets, moving funds, creating or
changing agents or policies. Those stay in the 1Claw dashboard.

## How a user connects (once)

1. Signed in to 1Claw, open **1claw.co/connect/muse**. The page calls `POST /v1/link` on this
   service with the user's session; the service asks the vault who they are and creates (or finds)
   their connection on the 1Claw-owned **Muse** platform app. An existing 1Claw user goes through
   the standard "Sign in with 1Claw" link consent once.
2. The user chooses which **agents** Muse may see (the connected-apps grant flow — a connection with
   no grants sees nothing).
3. The page shows the connector token (`mcn_…`) once. The user pastes it into Muse when Muse asks
   for the service's API credentials, with base URL `https://muse.1claw.co`.
4. Revoke any time: **Settings → Connected apps → Muse → Disconnect**. Every request re-checks the
   connection, so a revoked token stops working immediately.

## Security model

- **The `plt_` key never leaves this service.** Muse holds an HMAC-signed connector token that names
  one platform connection and nothing else. Its `mcn_` prefix is distinct from every vault credential
  (`ocv_`, `1ck_`, `plt_`), so the vault will never accept it and a leak is identifiable.
- **Stateless.** No database: the platform connection *is* the state. Revocation = disconnecting the
  app; tokens expire after a year; rotating `MUSE_CONNECTOR_SECRET` invalidates all of them.
- **Scoped by 1Claw, not by us.** Every call is a Platform API call resolved through the vault's
  `resolve_connection_for_platform` gate, so the user's grants, the agents' guardrails, the sanctions
  screen and the audit hash chain all apply unchanged.
- **Decisions bind to what was shown.** A consensus vote must echo the pending approval's
  `payload_hash`; the connector reads it fresh and ignores any hash in the request body.
- `/v1/link` accepts only browser origins on the 1Claw dashboard allowlist and only with a 1Claw
  user session; it never mints a token for an email the caller merely claims.

## Running it

```bash
npm install && npm run build
MUSE_CONNECTOR_SECRET='<≥32 random chars>' \
ONECLAW_PLATFORM_API_KEY='plt_…' ONECLAW_PLATFORM_APP_ID='<uuid of the Muse platform app>' \
npm start          # listens on :8787
```

| Env | Purpose |
|---|---|
| `MUSE_CONNECTOR_SECRET` | HMAC secret for connector tokens (≥32 chars). Rotate to revoke everything. |
| `ONECLAW_PLATFORM_API_KEY` | `plt_` key of the 1Claw-owned "Muse" platform app |
| `ONECLAW_PLATFORM_APP_ID` | That app's id |
| `ONECLAW_BASE_URL` | default `https://api.1claw.co` |
| `MUSE_CONNECTOR_PUBLIC_URL` | default `https://muse.1claw.co` (OpenAPI `servers`) |
| `ONECLAW_DASHBOARD_URL` | default `https://1claw.co` |
| `MUSE_CONNECTOR_LINK_ORIGINS` | comma list; default the 1Claw dashboard hosts |
| `PORT` | default `8787` |

Docker: `docker build -t muse-connector . && docker run -p 8787:8787 --env-file .env muse-connector`.

## Tests

- `npm test` — unit tests with a fake 1Claw port (tokens, the gate, queue merging, decide routing,
  link flow, CORS).
- `npm run e2e:prod` — creates a throwaway platform app on the SRE test account, provisions a user,
  starts the connector in-process and exercises every route end to end against `api.1claw.co`.
  Needs `ONECLAW_TEST_EMAIL` / `ONECLAW_TEST_PASSWORD`. Cleans up after itself.

## Submitting to Muse

See [`connector/SUBMISSION.md`](connector/SUBMISSION.md) for the directory listing text, the
security and legal answers, and the end-to-end test plan Meta's review asks for.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.
