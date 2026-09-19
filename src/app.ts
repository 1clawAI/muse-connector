/**
 * The connector HTTP surface. Two audiences:
 *
 *   1. Muse (Meta's assistant) as a Custom Connector — Muse "retrieves API
 *      information from the service" (our `/openapi.json` + `/llms.txt`) and
 *      calls the `/v1/*` routes with the connector token the user pasted into
 *      Muse's Secure Credentials Store.
 *   2. The 1Claw dashboard's "Connect Muse" page — `/v1/link`, which turns a
 *      signed-in 1Claw user into a platform connection on the 1Claw-owned
 *      "Muse" app and mints that token.
 *
 * Nothing here holds state and nothing here bypasses the vault: every
 * user-facing call is a Platform API call scoped to the user's connection,
 * so the same grants, guardrails and audit trail apply as for any platform app.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { mintToken, verifyToken, TOKEN_PREFIX } from "./tokens.js";
import type { OneclawPort } from "./oneclaw.js";
import { openapiDocument, llmsTxt } from "./openapi.js";
import { normalizeApproval } from "./normalize.js";

export interface AppConfig {
    /** HMAC secret for connector tokens (≥32 chars). */
    connectorSecret: string;
    /** Where this connector is served, for the OpenAPI `servers` entry. */
    publicUrl: string;
    /** Dashboard URL for the link page and the "manage in 1Claw" pointers. */
    dashboardUrl: string;
    /** Origins allowed to call `/v1/link` from a browser. */
    linkOrigins: string[];
}

type Env = { Variables: { cid: string } };

function problem(c: Context, status: 400 | 401 | 403 | 404 | 409 | 422 | 502, detail: string) {
    return c.json({ type: "about:blank", title: statusTitle(status), status, detail }, status);
}
function statusTitle(s: number): string {
    return { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 422: "Unprocessable", 502: "Bad Gateway" }[s] ?? "Error";
}

/** Map a 1Claw error (status on the Error) to a connector response. */
function upstream(c: Context, e: unknown) {
    const status = (e as { status?: number }).status;
    const msg = e instanceof Error ? e.message : "1Claw request failed";
    if (status === 404) return problem(c, 404, msg);
    if (status === 403) return problem(c, 403, msg);
    if (status === 401) return problem(c, 401, msg);
    if (status === 409) return problem(c, 409, msg);
    if (status === 400 || status === 422) return problem(c, 400, msg);
    return problem(c, 502, msg);
}

export function createApp(cfg: AppConfig, oneclaw: OneclawPort): Hono<Env> {
    const app = new Hono<Env>();

    // ── Discovery (public) ─────────────────────────────────────────
    app.get("/healthz", (c) => c.json({ ok: true, service: "1claw-muse-connector" }));
    app.get("/openapi.json", (c) => c.json(openapiDocument(cfg.publicUrl)));
    app.get("/llms.txt", (c) => c.text(llmsTxt(cfg.publicUrl, cfg.dashboardUrl)));
    app.get("/", (c) => c.text(llmsTxt(cfg.publicUrl, cfg.dashboardUrl)));

    // ── Link (dashboard, user JWT) ─────────────────────────────────
    app.options("/v1/link", (c) => cors(c, cfg, new Response(null, { status: 204 })));
    app.post("/v1/link", async (c) => {
        const origin = c.req.header("origin");
        if (origin && !cfg.linkOrigins.includes(origin)) return problem(c, 403, "origin not allowed");
        const jwt = bearer(c);
        if (!jwt) return problem(c, 401, "sign in to 1Claw first");
        const body = await c.req.json().catch(() => ({}));
        const parsed = z.object({ return_to: z.string().url().optional() }).safeParse(body);
        if (!parsed.success) return problem(c, 400, "return_to must be a URL");
        try {
            const me = await oneclaw.whoami(jwt);
            const existing = await oneclaw.findConnection(me.email);
            if (existing && existing.status !== "disconnected") {
                const token = mintToken(cfg.connectorSecret, existing.id);
                return cors(c, cfg, c.json({ status: "linked", connection_id: existing.id, token, manage_url: `${cfg.dashboardUrl}/settings/connected-apps` }));
            }
            const up = await oneclaw.upsertUser(me.email, parsed.data.return_to);
            if (up.connection_id) {
                const token = mintToken(cfg.connectorSecret, up.connection_id);
                return cors(c, cfg, c.json({ status: "linked", connection_id: up.connection_id, token, manage_url: `${cfg.dashboardUrl}/settings/connected-apps` }));
            }
            if (up.authorize_url) return cors(c, cfg, c.json({ status: "link_required", authorize_url: up.authorize_url }));
            return problem(c, 502, "1Claw returned neither a connection nor a link URL");
        } catch (e) {
            return cors(c, cfg, upstream(c, e));
        }
    });

    // ── Per-user API (Muse, connector token) ───────────────────────
    app.use("/v1/*", async (c, next) => {
        if (c.req.path === "/v1/link") return next();
        const token = bearer(c);
        if (!token) return problem(c, 401, `Authorization: Bearer ${TOKEN_PREFIX}… required`);
        const v = verifyToken(cfg.connectorSecret, token);
        if (!v.ok) return problem(c, 401, `invalid connector token (${v.reason})`);
        let conn;
        try {
            conn = await oneclaw.getConnection(v.payload.cid);
        } catch (e) {
            return upstream(c, e);
        }
        if (!conn) return problem(c, 401, "this connection no longer exists — reconnect Muse in 1Claw");
        if (conn.status === "disconnected") return problem(c, 401, "Muse was disconnected from this 1Claw account — reconnect at 1claw.co/settings/connected-apps");
        c.set("cid", conn.id);
        await next();
    });

    app.get("/v1/me", async (c) => {
        const cid = c.get("cid");
        try {
            const [conn, res] = await Promise.all([oneclaw.getConnection(cid), oneclaw.resources(cid)]);
            return c.json({ connection_id: cid, status: conn?.status, email: conn?.external_subject, resources: res, manage_url: `${cfg.dashboardUrl}/settings/connected-apps` });
        } catch (e) {
            return upstream(c, e);
        }
    });

    app.get("/v1/approvals", async (c) => {
        const cid = c.get("cid");
        try {
            const [pending, actions] = await Promise.all([oneclaw.listPendingApprovals(cid), oneclaw.listAgentApprovals(cid, "pending")]);
            const items = [...pending.map((p) => normalizeApproval("consensus", p)), ...actions.map((a) => normalizeApproval("agent_action", a))];
            return c.json({ approvals: items, count: items.length });
        } catch (e) {
            return upstream(c, e);
        }
    });

    app.get("/v1/approvals/:id", async (c) => {
        const cid = c.get("cid");
        const id = c.req.param("id");
        try {
            const found = await lookupApproval(oneclaw, cid, id);
            if (!found) return problem(c, 404, "approval not found");
            return c.json(found);
        } catch (e) {
            return upstream(c, e);
        }
    });

    app.post("/v1/approvals/:id/decide", async (c) => {
        const cid = c.get("cid");
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        const parsed = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(500).optional() }).safeParse(body);
        if (!parsed.success) return problem(c, 400, "decision must be 'approve' or 'reject'; reason ≤ 500 chars");
        try {
            const found = await lookupApproval(oneclaw, cid, id);
            if (!found) return problem(c, 404, "approval not found");
            if (found.status !== "pending") return problem(c, 409, `approval is already ${found.status}`);
            const { decision, reason } = parsed.data;
            const result =
                found.kind === "consensus"
                    ? await oneclaw.decidePendingApproval(cid, id, decision, reason, found.payload_hash)
                    : await oneclaw.decideAgentApproval(cid, id, decision === "approve" ? "approve" : "deny", reason);
            return c.json({ id, decision, result });
        } catch (e) {
            return upstream(c, e);
        }
    });

    app.get("/v1/portfolio", async (c) => {
        try {
            return c.json(await oneclaw.portfolio(c.get("cid"), c.req.query("chains")));
        } catch (e) {
            return upstream(c, e);
        }
    });
    app.get("/v1/balances", async (c) => {
        try {
            return c.json(await oneclaw.balances(c.get("cid"), c.req.query("chains")));
        } catch (e) {
            return upstream(c, e);
        }
    });
    app.get("/v1/automations", async (c) => {
        try {
            return c.json({ automations: await oneclaw.listAutomations(c.get("cid")) });
        } catch (e) {
            return upstream(c, e);
        }
    });
    app.get("/v1/activity", async (c) => {
        const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 100);
        try {
            return c.json({ events: await oneclaw.delegationLog(c.get("cid"), limit) });
        } catch (e) {
            return upstream(c, e);
        }
    });

    return app;
}

function bearer(c: Context): string | undefined {
    const h = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m?.[1]?.trim() || undefined;
}

function cors(c: Context, cfg: AppConfig, res: Response): Response {
    const origin = c.req.header("origin");
    if (origin && cfg.linkOrigins.includes(origin)) {
        res.headers.set("Access-Control-Allow-Origin", origin);
        res.headers.set("Access-Control-Allow-Headers", "authorization, content-type");
        res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.headers.set("Vary", "Origin");
    }
    return res;
}

/** Find an approval in either queue, normalized. Two round trips at most. */
async function lookupApproval(oneclaw: OneclawPort, cid: string, id: string) {
    const [pending, actions] = await Promise.all([
        oneclaw.getPendingApproval(cid, id).catch((e: { status?: number }) => (e.status === 404 ? undefined : Promise.reject(e))),
        oneclaw.getAgentApproval(cid, id).catch((e: { status?: number }) => (e.status === 404 ? undefined : Promise.reject(e))),
    ]);
    if (pending) return normalizeApproval("consensus", pending);
    if (actions) return normalizeApproval("agent_action", actions);
    return undefined;
}
