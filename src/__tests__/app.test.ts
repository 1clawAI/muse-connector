import { describe, it, expect, vi } from "vitest";
import { createApp } from "../app.js";
import { mintToken } from "../tokens.js";
import type { OneclawPort } from "../oneclaw.js";

const SECRET = "s".repeat(40);
const CID = "8f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7";
const cfg = { connectorSecret: SECRET, publicUrl: "https://muse.test", dashboardUrl: "https://1claw.test", linkOrigins: ["https://1claw.test"] };

function port(over: Partial<OneclawPort> = {}): OneclawPort {
    const notFound = Object.assign(new Error("nope"), { status: 404 });
    return {
        whoami: vi.fn(async () => ({ id: "u1", email: "kev@example.com", org_id: "o1" })),
        upsertUser: vi.fn(async () => ({ authorize_url: "https://1claw.test/oauth/authorize?x" })),
        findConnection: vi.fn(async () => undefined),
        getConnection: vi.fn(async (id: string) => (id === CID ? { id: CID, status: "active", external_subject: "kev@example.com" } : undefined)),
        listPendingApprovals: vi.fn(async () => [{ id: "pa1", status: "pending", payload_hash: "h1", action_payload: { action_type: "transaction.send", to: "0xabc", value: "0.5", chain: "base" } }]),
        getPendingApproval: vi.fn(async (_c: string, id: string) => { if (id !== "pa1") throw notFound; return { id: "pa1", status: "pending", payload_hash: "h1", action_payload: { action_type: "transaction.send" } }; }),
        decidePendingApproval: vi.fn(async () => ({ status: "approved" })),
        listAgentApprovals: vi.fn(async () => [{ id: "aa1", status: "pending", summary: "Send the weekly report to Bob", agent_name: "reporter" }]),
        getAgentApproval: vi.fn(async (_c: string, id: string) => { if (id !== "aa1") throw notFound; return { id: "aa1", status: "pending", summary: "Send the weekly report to Bob" }; }),
        decideAgentApproval: vi.fn(async () => ({ status: "denied" })),
        portfolio: vi.fn(async () => ({ total_usd: "12.34" })),
        balances: vi.fn(async () => ({ balances: [] })),
        listAutomations: vi.fn(async () => []),
        delegationLog: vi.fn(async () => [{ action: "secret.read" }]),
        resources: vi.fn(async () => ({ agents: [{ id: "a1" }] })),
        ...over,
    };
}

const auth = (t = mintToken(SECRET, CID)) => ({ Authorization: `Bearer ${t}` });

describe("discovery", () => {
    it("serves openapi and llms.txt without auth", async () => {
        const app = createApp(cfg, port());
        const o = await app.request("/openapi.json");
        expect(o.status).toBe(200);
        const doc = (await o.json()) as { servers: { url: string }[]; paths: Record<string, unknown> };
        expect(doc.servers[0].url).toBe("https://muse.test");
        expect(Object.keys(doc.paths)).toContain("/v1/approvals/{id}/decide");
        const l = await app.request("/llms.txt");
        expect(await l.text()).toContain("mcn_");
    });
});

describe("token gate", () => {
    it("401 without, with a foreign, or with a revoked token", async () => {
        const app = createApp(cfg, port());
        expect((await app.request("/v1/approvals")).status).toBe(401);
        expect((await app.request("/v1/approvals", { headers: { Authorization: "Bearer ocv_abc" } })).status).toBe(401);
        const disconnected = port({ getConnection: vi.fn(async () => ({ id: CID, status: "disconnected" })) });
        const r = await createApp(cfg, disconnected).request("/v1/approvals", { headers: auth() });
        expect(r.status).toBe(401);
        expect(((await r.json()) as { detail: string }).detail).toMatch(/disconnected/);
    });
});

describe("approvals", () => {
    it("merges both queues into one normalized list", async () => {
        const app = createApp(cfg, port());
        const r = await app.request("/v1/approvals", { headers: auth() });
        expect(r.status).toBe(200);
        const body = (await r.json()) as { approvals: Array<{ id: string; kind: string; summary: string; payload_hash?: string }>; count: number };
        expect(body.count).toBe(2);
        const consensus = body.approvals.find((a) => a.id === "pa1")!;
        expect(consensus.kind).toBe("consensus");
        expect(consensus.summary).toBe("transaction.send: send 0.5 on base to 0xabc");
        expect(consensus.payload_hash).toBe("h1");
        expect(body.approvals.find((a) => a.id === "aa1")!.summary).toBe("Send the weekly report to Bob");
    });
    it("decide routes to the right queue and echoes the payload hash it read, never one from the caller", async () => {
        const p = port();
        const app = createApp(cfg, p);
        const r1 = await app.request("/v1/approvals/pa1/decide", { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ decision: "approve", payload_hash: "attacker" }) });
        expect(r1.status).toBe(200);
        expect(p.decidePendingApproval).toHaveBeenCalledWith(CID, "pa1", "approve", undefined, "h1");
        const r2 = await app.request("/v1/approvals/aa1/decide", { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ decision: "reject", reason: "not now" }) });
        expect(r2.status).toBe(200);
        expect(p.decideAgentApproval).toHaveBeenCalledWith(CID, "aa1", "deny", "not now");
    });
    it("400 on a bad decision, 404 on an unknown id, 409 when already decided", async () => {
        const app = createApp(cfg, port({ getAgentApproval: vi.fn(async (_c: string, id: string) => { if (id !== "aa1") throw Object.assign(new Error("nope"), { status: 404 }); return { id: "aa1", status: "approved", summary: "x" }; }) }));
        const bad = await app.request("/v1/approvals/pa1/decide", { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ decision: "maybe" }) });
        expect(bad.status).toBe(400);
        const missing = await app.request("/v1/approvals/zzz/decide", { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
        expect(missing.status).toBe(404);
        const done = await app.request("/v1/approvals/aa1/decide", { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
        expect(done.status).toBe(409);
    });
});

describe("link", () => {
    it("returns the authorize URL for an unlinked user and a token once linked", async () => {
        const p = port();
        const app = createApp(cfg, p);
        const first = await app.request("/v1/link", { method: "POST", headers: { Authorization: "Bearer userjwt", origin: "https://1claw.test", "content-type": "application/json" }, body: "{}" });
        expect(first.status).toBe(200);
        expect((await first.json()) as object).toMatchObject({ status: "link_required" });
        expect(first.headers.get("access-control-allow-origin")).toBe("https://1claw.test");

        const linked = createApp(cfg, port({ findConnection: vi.fn(async () => ({ id: CID, status: "active" })) }));
        const second = await linked.request("/v1/link", { method: "POST", headers: { Authorization: "Bearer userjwt", "content-type": "application/json" }, body: "{}" });
        const body = (await second.json()) as { status: string; token: string };
        expect(body.status).toBe("linked");
        expect(body.token.startsWith("mcn_")).toBe(true);
    });
    it("refuses a foreign origin and an unauthenticated call", async () => {
        const app = createApp(cfg, port());
        expect((await app.request("/v1/link", { method: "POST", headers: { Authorization: "Bearer j", origin: "https://evil.test" }, body: "{}" })).status).toBe(403);
        expect((await app.request("/v1/link", { method: "POST", body: "{}" })).status).toBe(401);
    });
});
