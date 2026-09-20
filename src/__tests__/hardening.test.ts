import { describe, it, expect, vi } from "vitest";
import { createApp } from "../app.js";
import { mintToken } from "../tokens.js";
import { createRateLimiter } from "../ratelimit.js";
import type { OneclawPort } from "../oneclaw.js";

const SECRET = "s".repeat(40);
const CID = "8f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7";
const base = { connectorSecret: SECRET, publicUrl: "https://muse.test", dashboardUrl: "https://1claw.test", linkOrigins: ["https://1claw.test"] };

function port(): OneclawPort {
    const notFound = Object.assign(new Error("nope"), { status: 404 });
    return {
        whoami: vi.fn(async () => ({ id: "u1", email: "kev@example.com", org_id: "o1" })),
        upsertUser: vi.fn(async () => ({ connection_id: CID })),
        findConnection: vi.fn(async () => undefined),
        getConnection: vi.fn(async (id: string) => (id === CID ? { id: CID, status: "active" } : undefined)),
        listPendingApprovals: vi.fn(async () => []),
        getPendingApproval: vi.fn(async () => { throw notFound; }),
        decidePendingApproval: vi.fn(async () => ({})),
        listAgentApprovals: vi.fn(async () => []),
        getAgentApproval: vi.fn(async () => { throw notFound; }),
        decideAgentApproval: vi.fn(async () => ({})),
        portfolio: vi.fn(async () => ({})),
        balances: vi.fn(async () => ({})),
        listAutomations: vi.fn(async () => []),
        delegationLog: vi.fn(async () => []),
        resources: vi.fn(async () => ({})),
    };
}
const auth = (t = mintToken(SECRET, CID)) => ({ Authorization: `Bearer ${t}` });

describe("rate limits", () => {
    it("caps requests per connector token and answers 429", async () => {
        const app = createApp({ ...base, limits: { perToken: createRateLimiter(2), perIp: createRateLimiter(1000), link: createRateLimiter(1000) } }, port());
        const h = auth();
        expect((await app.request("/v1/me", { headers: h })).status).toBe(200);
        expect((await app.request("/v1/me", { headers: h })).status).toBe(200);
        const r = await app.request("/v1/me", { headers: h });
        expect(r.status).toBe(429);
        // A different token is a different bucket.
        expect((await app.request("/v1/me", { headers: auth(mintToken(SECRET, CID)) })).status).toBe(200);
    });

    it("caps bad-token attempts per address before the vault is asked anything", async () => {
        const p = port();
        const app = createApp({ ...base, limits: { perToken: createRateLimiter(1000), perIp: createRateLimiter(3), link: createRateLimiter(1000) } }, p);
        const hdr = { Authorization: "Bearer mcn_bogus.sig", "x-forwarded-for": "203.0.113.9" };
        for (let i = 0; i < 3; i++) expect((await app.request("/v1/me", { headers: hdr })).status).toBe(401);
        expect((await app.request("/v1/me", { headers: hdr })).status).toBe(429);
        expect(p.getConnection).not.toHaveBeenCalled();
        // The last X-Forwarded-For hop is the key: a spoofed first entry does not dodge it.
        expect((await app.request("/v1/me", { headers: { ...hdr, "x-forwarded-for": "198.51.100.1, 203.0.113.9" } })).status).toBe(429);
    });

    it("caps /v1/link per address", async () => {
        const app = createApp({ ...base, limits: { perToken: createRateLimiter(1000), perIp: createRateLimiter(1000), link: createRateLimiter(1) } }, port());
        const req = () => app.request("/v1/link", { method: "POST", headers: { Authorization: "Bearer user.jwt.here", "Content-Type": "application/json", "x-forwarded-for": "203.0.113.5" }, body: "{}" });
        expect((await req()).status).toBe(200);
        expect((await req()).status).toBe(429);
    });
});

describe("request hygiene", () => {
    it("refuses a connector token on /v1/link", async () => {
        const app = createApp(base, port());
        const r = await app.request("/v1/link", { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: "{}" });
        expect(r.status).toBe(401);
    });

    it("rejects oversized bodies", async () => {
        const app = createApp(base, port());
        const r = await app.request("/v1/approvals/pa1/decide", { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve", reason: "x".repeat(20_000) }) });
        expect(r.status).toBe(413);
    });

    it("sets no-store and nosniff on API responses", async () => {
        const app = createApp(base, port());
        const r = await app.request("/v1/me", { headers: auth() });
        expect(r.headers.get("cache-control")).toBe("no-store");
        expect(r.headers.get("x-content-type-options")).toBe("nosniff");
        expect(r.headers.get("x-frame-options")).toBe("DENY");
    });

    it("never echoes the connector token or the platform key in a response", async () => {
        const app = createApp(base, port());
        const t = mintToken(SECRET, CID);
        const r = await app.request("/v1/me", { headers: auth(t) });
        const text = await r.text();
        expect(text).not.toContain(t);
        expect(text).not.toContain("plt_");
    });
});

describe("token bucket", () => {
    it("refills over time and evicts when full", () => {
        const l = createRateLimiter(60, 2);
        const t0 = 1_000_000;
        expect(l.take("a", t0)).toBe(true);
        expect(l.take("b", t0)).toBe(true);
        expect(l.take("c", t0)).toBe(true); // evicts the stalest
        for (let i = 0; i < 59; i++) l.take("c", t0);
        expect(l.take("c", t0)).toBe(false);
        expect(l.take("c", t0 + 1_000)).toBe(true); // one token back after a second
    });
});
