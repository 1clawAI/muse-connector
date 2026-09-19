/**
 * What Muse ingests. Kept deliberately small and plain-spoken: a consumer
 * assistant reads this to decide when to call what, so every description
 * says what the person would see and what the call will *not* do.
 */
export function openapiDocument(publicUrl: string): Record<string, unknown> {
    const approval = {
        type: "object",
        properties: {
            id: { type: "string" },
            kind: { type: "string", enum: ["consensus", "agent_action"], description: "Which queue it came from. Callers never need to branch on it." },
            status: { type: "string", enum: ["pending", "approved", "rejected", "expired", "cancelled"] },
            summary: { type: "string", description: "One line a person can decide on." },
            details: { type: "object", additionalProperties: true },
            risk_tier: { type: "integer", nullable: true },
            requested_by: { type: "string", nullable: true },
            created_at: { type: "string", format: "date-time", nullable: true },
            expires_at: { type: "string", format: "date-time", nullable: true },
        },
        required: ["id", "kind", "status", "summary", "details"],
    };
    return {
        openapi: "3.1.0",
        info: {
            title: "1Claw for Muse",
            version: "0.1.0",
            description:
                "Your 1Claw agents, from Muse: see what your AI agents are asking permission for, approve or reject it, and check the wallets they run on. " +
                "Read-and-decide only — nothing here moves funds, reads secrets, or changes an agent. Every call is scoped to the 1Claw account that created the token and is written to that account's audit log.",
            "x-1claw-connector": "muse",
        },
        servers: [{ url: publicUrl }],
        security: [{ connectorToken: [] }],
        components: {
            securitySchemes: {
                connectorToken: {
                    type: "http",
                    scheme: "bearer",
                    description: "The connector token from 1Claw (starts with `mcn_`). Get it at 1claw.co/connect/muse. Revoke it any time at 1claw.co/settings/connected-apps.",
                },
            },
            schemas: {
                Approval: approval,
                Problem: { type: "object", properties: { title: { type: "string" }, status: { type: "integer" }, detail: { type: "string" } } },
            },
            responses: {
                Unauthorized: { description: "Missing, invalid, expired or revoked connector token", content: { "application/json": { schema: { $ref: "#/components/schemas/Problem" } } } },
                NotFound: { description: "No such approval on this account", content: { "application/json": { schema: { $ref: "#/components/schemas/Problem" } } } },
            },
        },
        paths: {
            "/v1/me": {
                get: {
                    operationId: "whoAmI",
                    summary: "Which 1Claw account this token acts for, and what Muse has been granted",
                    responses: { "200": { description: "Account and granted resources", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } }, "401": { $ref: "#/components/responses/Unauthorized" } },
                },
            },
            "/v1/approvals": {
                get: {
                    operationId: "listPendingApprovals",
                    summary: "Everything waiting for the person's decision",
                    description: "Use this when the person asks anything like 'is anything waiting on me', 'what are my agents asking for', or before deciding. Returns only pending items.",
                    responses: { "200": { description: "Pending approvals", content: { "application/json": { schema: { type: "object", properties: { approvals: { type: "array", items: { $ref: "#/components/schemas/Approval" } }, count: { type: "integer" } } } } } }, "401": { $ref: "#/components/responses/Unauthorized" } },
                },
            },
            "/v1/approvals/{id}": {
                get: {
                    operationId: "getApproval",
                    summary: "One approval with its full details",
                    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                    responses: { "200": { description: "The approval", content: { "application/json": { schema: { $ref: "#/components/schemas/Approval" } } } }, "404": { $ref: "#/components/responses/NotFound" } },
                },
            },
            "/v1/approvals/{id}/decide": {
                post: {
                    operationId: "decideApproval",
                    summary: "Approve or reject one pending approval",
                    description:
                        "Only call this after reading the approval's summary back to the person and getting an explicit yes or no for *that* item. " +
                        "Never decide more than one approval per confirmation. A rejection should carry the person's reason. This is the only write in this API.",
                    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["decision"], properties: { decision: { type: "string", enum: ["approve", "reject"] }, reason: { type: "string", maxLength: 500 } } } } } },
                    responses: { "200": { description: "Decision recorded" }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Already decided or expired" } },
                },
            },
            "/v1/portfolio": {
                get: {
                    operationId: "getPortfolio",
                    summary: "Balances across the wallets Muse has been granted, with token holdings",
                    parameters: [{ name: "chains", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated chain names to limit to (e.g. base,ethereum)." }],
                    responses: { "200": { description: "Portfolio", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } },
                },
            },
            "/v1/balances": {
                get: {
                    operationId: "getBalances",
                    summary: "Native balances only (lighter than portfolio)",
                    parameters: [{ name: "chains", in: "query", required: false, schema: { type: "string" } }],
                    responses: { "200": { description: "Balances", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } },
                },
            },
            "/v1/automations": {
                get: {
                    operationId: "listAutomations",
                    summary: "Scheduled and event-driven jobs the granted agents run",
                    responses: { "200": { description: "Automations", content: { "application/json": { schema: { type: "object", properties: { automations: { type: "array", items: { type: "object", additionalProperties: true } } } } } } } },
                },
            },
            "/v1/activity": {
                get: {
                    operationId: "getActivity",
                    summary: "Recent things the granted agents did on the person's behalf",
                    parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } }],
                    responses: { "200": { description: "Activity", content: { "application/json": { schema: { type: "object", properties: { events: { type: "array", items: { type: "object", additionalProperties: true } } } } } } } },
                },
            },
        },
        "x-responses-note": "Errors are RFC 9457 problem JSON.",
    };
}

export function llmsTxt(publicUrl: string, dashboardUrl: string): string {
    return `# 1Claw for Muse

1Claw runs AI agents with real credentials and wallets under human control. This connector lets Muse
act as that human's assistant for the part that needs a person: seeing what agents are asking for,
approving or rejecting it, and checking the wallets those agents run on.

## Setup (for the person, once)
1. Open ${dashboardUrl}/connect/muse while signed in to 1Claw.
2. Choose which agents Muse may see, then copy the connector token (starts with \`mcn_\`).
3. Give the token to Muse when it asks for API credentials. Base URL: ${publicUrl}
4. Revoke any time at ${dashboardUrl}/settings/connected-apps.

## API
OpenAPI: ${publicUrl}/openapi.json — Bearer token auth, JSON responses, RFC 9457 errors.

- GET /v1/me — which account and what was granted
- GET /v1/approvals — everything waiting on the person (only pending)
- GET /v1/approvals/{id} — full details of one
- POST /v1/approvals/{id}/decide {"decision":"approve"|"reject","reason"?} — the only write
- GET /v1/portfolio, GET /v1/balances — wallets the granted agents use
- GET /v1/automations — the agents' scheduled/event jobs
- GET /v1/activity — what the agents did recently

## Rules for the assistant
- Read an approval's summary back to the person and get an explicit yes/no for that item before deciding it. One decision per confirmation.
- This API cannot move funds, read secrets, create agents, or change policies. If asked, say so and point to ${dashboardUrl}.
- A 401 means the person disconnected Muse in 1Claw or the token expired: ask them to reconnect at ${dashboardUrl}/connect/muse.
`;
}
