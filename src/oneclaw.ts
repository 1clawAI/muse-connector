/**
 * The connector's view of 1Claw: one platform app ("Muse", owned by 1Claw)
 * and one `plt_` key that never leaves this service. Every user-facing call
 * is scoped by the platform *connection* the user's token names, which the
 * vault resolves with `resolve_connection_for_platform` — the same gate every
 * platform-delegated route has.
 */
import { OneclawClient } from "@1claw/sdk";

export interface ConnectionInfo {
    id: string;
    status: string;
    external_subject?: string;
    user_id?: string;
}

export interface OneclawPort {
    /** Who the bearer of a 1Claw user JWT is (for the link flow). */
    whoami(userJwt: string): Promise<{ id: string; email: string; org_id: string }>;
    /** Upsert the platform user; returns a connection id or the link URL the user must visit. */
    upsertUser(email: string, returnTo?: string): Promise<{ connection_id?: string; authorize_url?: string }>;
    /** Find the connection for a subject (email) on the Muse app. */
    findConnection(email: string): Promise<ConnectionInfo | undefined>;
    getConnection(connectionId: string): Promise<ConnectionInfo | undefined>;
    listPendingApprovals(connectionId: string): Promise<Array<Record<string, unknown>>>;
    getPendingApproval(connectionId: string, id: string): Promise<Record<string, unknown>>;
    decidePendingApproval(connectionId: string, id: string, decision: "approve" | "reject", reason: string | undefined, payloadHash: string | undefined): Promise<Record<string, unknown>>;
    listAgentApprovals(connectionId: string, status?: string): Promise<Array<Record<string, unknown>>>;
    getAgentApproval(connectionId: string, id: string): Promise<Record<string, unknown>>;
    decideAgentApproval(connectionId: string, id: string, decision: "approve" | "deny", reason?: string): Promise<Record<string, unknown>>;
    portfolio(connectionId: string, chains?: string): Promise<Record<string, unknown>>;
    balances(connectionId: string, chains?: string): Promise<Record<string, unknown>>;
    listAutomations(connectionId: string): Promise<unknown[]>;
    delegationLog(connectionId: string, limit?: number): Promise<unknown[]>;
    resources(connectionId: string): Promise<Record<string, unknown>>;
}

export interface OneclawConfig {
    baseUrl: string;
    platformApiKey: string;
    platformAppId: string;
}

import type { OneclawResponse } from "@1claw/sdk";

/** Unwrap an SDK response; a 1Claw error becomes an Error carrying its HTTP status. */
function data<T>(r: OneclawResponse<T>): T {
    if (r.error || r.data === null) {
        throw Object.assign(new Error(r.error?.message ?? "1Claw error"), { status: (r.meta as { status?: number } | undefined)?.status ?? statusFromType(r.error?.type) });
    }
    return r.data;
}
function statusFromType(t?: string): number {
    if (!t) return 502;
    if (/not.?found/i.test(t)) return 404;
    if (/forbidden/i.test(t)) return 403;
    if (/unauthori/i.test(t)) return 401;
    if (/conflict/i.test(t)) return 409;
    if (/bad.?request|validation/i.test(t)) return 400;
    return 502;
}

export function createOneclawPort(cfg: OneclawConfig): OneclawPort {
    // `token`, not `apiKey`: the SDK only treats `ocv_` keys as apiKey and silently
    // ignores anything else, so a plt_ key passed as apiKey sends no auth at all.
    const client = new OneclawClient({ baseUrl: cfg.baseUrl, token: cfg.platformApiKey });
    const p = client.platform;
    return {
        async whoami(userJwt) {
            const res = await fetch(`${cfg.baseUrl}/v1/auth/me`, { headers: { Authorization: `Bearer ${userJwt}` } });
            if (!res.ok) throw Object.assign(new Error("not signed in to 1Claw"), { status: 401 });
            const me = (await res.json()) as { id: string; email: string; org_id: string };
            return { id: me.id, email: me.email, org_id: me.org_id };
        },
        async upsertUser(email, returnTo) {
            // 409 is the normal "link required" answer for an existing 1Claw
            // user, and the SDK accepts it as data rather than error.
            const r = await p.upsertUser({ email, return_to: returnTo });
            const d = r.data as { connection_id?: string; link_required?: { authorize_url: string } } | null;
            if (r.error && !d) throw Object.assign(new Error(r.error.message ?? "upsert failed"), { status: statusFromType(r.error.type) });
            return { connection_id: d?.connection_id, authorize_url: d?.link_required?.authorize_url };
        },
        async findConnection(email) {
            const users = data(await p.listUsers(cfg.platformAppId)).users;
            const u = users.find((x: { external_subject?: string }) => x.external_subject?.toLowerCase() === email.toLowerCase());
            return u ? { id: u.connection_id, status: u.status, external_subject: u.external_subject, user_id: u.user_id } : undefined;
        },
        async getConnection(connectionId) {
            const res = await fetch(`${cfg.baseUrl}/v1/platform/connections/${connectionId}`, {
                headers: { Authorization: `Bearer ${cfg.platformApiKey}` },
            });
            if (res.status === 404) return undefined;
            if (!res.ok) throw Object.assign(new Error("connection lookup failed"), { status: res.status });
            // The route answers `connection_id` / `email`, not `id` / `external_subject`.
            const c = (await res.json()) as { connection_id?: string; id?: string; status?: string; email?: string; external_subject?: string; user_id?: string };
            const id = c.connection_id ?? c.id;
            if (!id) return undefined;
            return { id, status: c.status ?? "active", external_subject: c.email ?? c.external_subject, user_id: c.user_id };
        },
        async listPendingApprovals(cid) {
            return data(await p.listConnectionPendingApprovals(cid, { status: "pending", limit: 50 })).pending_approvals;
        },
        async getPendingApproval(cid, id) {
            return data(await p.getConnectionPendingApproval(cid, id));
        },
        async decidePendingApproval(cid, id, decision, reason, payloadHash) {
            // The vault binds the vote to the payload it showed (TOCTOU): the
            // hash comes from the GET, never from the caller.
            return data(await p.decideConnectionPendingApproval(cid, id, { decision, reason, payload_hash: payloadHash } as never));
        },
        async listAgentApprovals(cid, status = "pending") {
            return data(await p.listConnectionApprovals(cid, { status: status as "pending", limit: 50 })).approvals as never;
        },
        async getAgentApproval(cid, id) {
            return data(await p.getConnectionApproval(cid, id)) as never;
        },
        async decideAgentApproval(cid, id, decision, reason) {
            // This route wants the past tense; the consensus one accepts both.
            const d = decision === "approve" ? "approved" : "rejected";
            return data(await p.decideConnectionApproval(cid, id, { decision: d, reason } as never));
        },
        async portfolio(cid, chains) {
            return data(await p.getConnectionPortfolio(cid, chains ? { chains, include_tokens: true } : { include_tokens: true }));
        },
        async balances(cid, chains) {
            return data(await p.getConnectionBalances(cid, chains ? { chains } : undefined));
        },
        async listAutomations(cid) {
            return data(await p.listConnectionAutomations(cid)).automations;
        },
        async delegationLog(cid, limit = 25) {
            const res = await fetch(`${cfg.baseUrl}/v1/platform/connections/${cid}/delegation-log?limit=${limit}`, {
                headers: { Authorization: `Bearer ${cfg.platformApiKey}` },
            });
            if (!res.ok) throw Object.assign(new Error("activity lookup failed"), { status: res.status });
            const d = (await res.json()) as { events?: unknown[]; entries?: unknown[] };
            return d.events ?? d.entries ?? [];
        },
        async resources(cid) {
            const res = await fetch(`${cfg.baseUrl}/v1/platform/connections/${cid}/resources`, {
                headers: { Authorization: `Bearer ${cfg.platformApiKey}` },
            });
            if (!res.ok) throw Object.assign(new Error("resources lookup failed"), { status: res.status });
            return (await res.json()) as Record<string, unknown>;
        },
    };
}
