# Muse connector submission kit

What to paste into [muse.ai/platform → Submit a connector](https://muse.ai/platform), and what to
have ready for Meta's functional / security / legal review. Everything here describes the shipped
service; nothing is aspirational.

## 1. Describe your product

**Name:** 1Claw

**One line:** Approve what your AI agents are asking for, and see what they did — from Muse.

**Description (directory):**
1Claw runs AI agents with real credentials and crypto wallets under human control: agents ask,
people approve, and every action is written to a tamper-evident audit log. The 1Claw connector
brings the part that needs a person into Muse. Ask Muse "is anything waiting on me?" and it lists
what your agents are asking permission for — a payment, a policy change, a message to send — in
plain language. Say yes or no and Muse records your decision in 1Claw. Ask "how are my agents'
wallets doing?" or "what did my agents do today?" and Muse answers from your account. Muse cannot
move funds, read your secrets or change an agent through this connector; those stay in the 1Claw
dashboard.

**Category:** Productivity / Finance / Developer tools

**How users will use it:**
- Morning check: "Anything waiting on me in 1Claw?" → Muse lists pending approvals with summaries.
- Decide: "Approve the Base payment to the supplier" → Muse reads the exact item back, confirms, decides.
- Awareness: "What did my agents do overnight?" → recent delegated actions.
- Balances: "How much USDC is in the trading agent's wallet?"

**Setup:** The user opens 1claw.co/connect/muse, chooses which agents Muse may see, and pastes the
connector token into Muse. Base URL `https://muse.1claw.co`; API description at
`https://muse.1claw.co/openapi.json` and `https://muse.1claw.co/llms.txt`.

## 2. Security review — answers

| Question | Answer |
|---|---|
| Authentication | Bearer token issued by 1Claw (`mcn_…`), HMAC-signed, names exactly one platform connection, expires in 365 days. Not an OAuth token and not a 1Claw account credential. |
| What can the token do | Read pending approvals, approve/reject one at a time, read wallet balances, automations and activity for the agents the user explicitly granted. Nothing else; the API has one write route. |
| What it cannot do | Read secrets or credentials, sign or send transactions, create/modify/delete agents, policies, vaults, or automations, change any setting. |
| Revocation | User: 1claw.co → Settings → Connected apps → Disconnect (immediate; every request re-checks). Operator: rotate `MUSE_CONNECTOR_SECRET` (all tokens). |
| Data minimisation | Responses carry approval summaries, balances and activity for granted agents only. No secret material is ever returned. Portfolio omits private keys by construction (the vault has no route that returns them). |
| Data retention by the connector | None. The service is stateless; it holds no user data at rest. Logs contain connection ids and route names, never token values. |
| Transport | TLS only (Cloud Run managed certificates). HSTS on `muse.1claw.co`. |
| Audit | Every decision is recorded in the user's 1Claw audit log (HMAC hash chain) with actor = the user, via platform app "Muse". |
| Abuse controls | Per-connection scoping is enforced by the 1Claw vault, not by this service; rate limits at the vault edge apply. Decide rejects a second decision (409) and requires the approval to be pending. |
| Injection | The connector's instructions (`/llms.txt`) tell the assistant to read the approval back and get an explicit yes/no per item before deciding. The vault additionally screens transaction recipients against OFAC before any approval can be executed. |
| Secrets in the service | One `plt_` platform key and one HMAC secret, both in Google Secret Manager, never in the image or logs. |
| Source | Apache-2.0, https://github.com/1clawAI/muse-connector |

## 3. Legal

- Terms: https://1claw.co/terms · Privacy: https://1claw.co/privacy
- The connector processes data on behalf of the 1Claw account holder under the 1Claw terms; no data
  is shared with third parties beyond Meta (as the caller) and 1Claw.
- Support: support@1claw.co

## 4. End-to-end test plan (for Meta's testers)

Test account: a 1Claw account will be provisioned for Meta's reviewer on request with two agents,
one pending consensus approval (a small test-net transaction) and one pending agent action approval.

1. Setup — open 1claw.co/connect/muse as the test user, grant both agents, copy the token; give Muse
   base URL + token. Expect Muse to acknowledge the connector.
2. `GET /v1/me` — Muse reports the account email and two granted agents.
3. "Is anything waiting on me?" — two items with plain-language summaries.
4. "Reject the agent's request, reason: testing" — Muse confirms, then `decide` → 200; the item
   disappears from the list; the 1Claw dashboard shows it rejected with the reason.
5. "Approve the transaction" — Muse reads it back; on yes → 200; dashboard shows approved.
6. "What did my agents do today?" — the two decisions appear in activity.
7. Disconnect in 1Claw → any further Muse call returns 401 with a reconnect hint.
8. Negative: a token from another account cannot read this account (401/404); a decision on an
   already-decided item → 409.

`npm run e2e:prod` automates steps 2–8 against production.
