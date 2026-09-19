#!/usr/bin/env node
/**
 * End to end against production: a throwaway platform app on the SRE test
 * account, a provisioned + bootstrapped user, the connector running
 * in-process, every route exercised, then cleanup.
 *
 * Env: ONECLAW_TEST_EMAIL, ONECLAW_TEST_PASSWORD (or ONECLAW_EMAIL/PASSWORD),
 *      ONECLAW_API_URL (default https://api.1claw.co)
 */
import { createApp } from "../dist/app.js";
import { createOneclawPort } from "../dist/oneclaw.js";
import { mintToken } from "../dist/tokens.js";

const API = (process.env.ONECLAW_API_URL ?? process.env.ONECLAW_BASE_URL ?? "https://api.1claw.co").replace(/\/$/, "");
const EMAIL = process.env.ONECLAW_TEST_EMAIL ?? process.env.ONECLAW_EMAIL;
const PASSWORD = process.env.ONECLAW_TEST_PASSWORD ?? process.env.ONECLAW_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error("Set ONECLAW_TEST_EMAIL and ONECLAW_TEST_PASSWORD"); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };
const bad = (name, why) => { fail++; console.log(`  ✗ ${name} ${why ?? ""}`); };
const check = (cond, name, why) => (cond ? ok(name) : bad(name, why));

async function api(method, path, token, body, extra = {}) {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
}

console.log(`\n1Claw Muse Connector — production E2E (${API})\n`);
const login = await api("POST", "/v1/auth/token", "", { email: EMAIL, password: PASSWORD });
const USER_JWT = login.json?.access_token;
if (!USER_JWT) { console.error("could not authenticate"); process.exit(2); }

const suffix = Math.floor(Math.random() * 1e6);
let appId, pltKey, connId, agentId;
try {
    // ── platform app (throwaway) ─────────────────────────────────
    const app = await api("POST", "/v1/platform/apps", USER_JWT, { name: "SRE Muse E2E", slug: `sre-muse-${suffix}`, description: "muse-connector e2e" });
    if (app.status === 403) { console.log("  ⊘ platform API needs Pro+; skipping"); process.exit(0); }
    if (app.status === 202) { console.log("  ⊘ org gates platform app creation on consensus; skipping"); process.exit(0); }
    check(app.status === 201 || app.status === 200, "create platform app", `HTTP ${app.status}`);
    appId = app.json?.id; pltKey = app.json?.api_key;
    if (!appId || !pltKey) throw new Error("no app id/key");

    // ── template + user + bootstrap → one agent on the connection ──
    const tpl = await api("POST", `/v1/platform/apps/${appId}/templates`, pltKey, { name: "muse-e2e", spec: { vault: { name: "muse-vault" }, agents: [{ name: "muse-agent" }] } });
    check(tpl.status === 201 || tpl.status === 200, "create template", `HTTP ${tpl.status}`);
    const up = await api("POST", "/v1/platform/users/upsert", pltKey, { email: `sre-muse-${suffix}@example.com` });
    connId = up.json?.connection_id;
    check(!!connId, "provision user → connection", `HTTP ${up.status}`);
    const boot = await api("POST", `/v1/platform/connections/${connId}/bootstrap`, pltKey, { template_id: tpl.json?.id, parameters: {} }, { "Idempotency-Key": `muse-e2e-${suffix}` });
    agentId = boot.json?.summary?.agent_id ?? boot.json?.summary?.agent_ids?.[0];
    check(!!agentId, "bootstrap → agent", `HTTP ${boot.status} ${JSON.stringify(boot.json).slice(0, 120)}`);

    // ── an agent action approval to decide ───────────────────────
    const ap = await api("POST", `/v1/platform/connections/${connId}/approvals`, pltKey, {
        agent_id: agentId, action: "email.send", target_type: "message", target_id: `msg-${suffix}`,
        summary: { text: "Send the weekly report to Bob" }, reason: "muse e2e",
    });
    const approvalId = ap.json?.id ?? ap.json?.approval?.id;
    check(!!approvalId, "create pending agent approval", `HTTP ${ap.status} ${JSON.stringify(ap.json).slice(0, 160)}`);

    // ── the connector, in-process ────────────────────────────────
    const secret = "e2e-" + "x".repeat(40);
    const connector = createApp(
        { connectorSecret: secret, publicUrl: "https://muse.test", dashboardUrl: "https://1claw.co", linkOrigins: ["https://1claw.co"] },
        createOneclawPort({ baseUrl: API, platformApiKey: pltKey, platformAppId: appId }),
    );
    const call = (path, init = {}, token = mintToken(secret, connId)) =>
        connector.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });

    let r = await call("/v1/me");
    check(r.status === 200 && (await r.json()).connection_id === connId, "GET /v1/me", `HTTP ${r.status}`);

    r = await call("/v1/approvals");
    const list = await r.json();
    const mine = list.approvals?.find((a) => a.id === approvalId);
    check(r.status === 200 && !!mine, "GET /v1/approvals lists the pending item", `HTTP ${r.status} ${JSON.stringify(list).slice(0, 160)}`);
    check(mine?.summary?.includes("weekly report") || typeof mine?.summary === "string", "the item has a human summary", JSON.stringify(mine?.summary));

    r = await call(`/v1/approvals/${approvalId}`);
    check(r.status === 200, "GET /v1/approvals/{id}", `HTTP ${r.status}`);

    r = await call(`/v1/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify({ decision: "reject", reason: "e2e" }) });
    check(r.status === 200, "decide → reject", `HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
    r = await call(`/v1/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    check(r.status === 409, "a second decision → 409", `HTTP ${r.status}`);
    r = await call("/v1/approvals");
    check(!(await r.json()).approvals?.some((a) => a.id === approvalId), "decided item is gone from the pending list");

    for (const p of ["/v1/portfolio", "/v1/balances", "/v1/automations", "/v1/activity"]) {
        r = await call(p);
        check(r.status === 200, `GET ${p}`, `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    }

    // ── negatives ────────────────────────────────────────────────
    r = await call("/v1/approvals", {}, mintToken(secret, "00000000-0000-4000-8000-000000000000"));
    check(r.status === 401 || r.status === 404, "a token for a connection that is not ours → 401/404", `HTTP ${r.status}`);
    r = await call("/v1/approvals", {}, "ocv_not_a_connector_token");
    check(r.status === 401, "a vault credential is not a connector token → 401", `HTTP ${r.status}`);
    r = await connector.request("/openapi.json");
    check(r.status === 200 && Object.keys((await r.json()).paths).length >= 7, "openapi served");

    // ── disconnect → 401 ─────────────────────────────────────────
    const dis = await api("DELETE", `/v1/platform/connections/${connId}`, pltKey);
    if (dis.status === 200 || dis.status === 204) {
        r = await call("/v1/approvals");
        check(r.status === 401, "after disconnect, the token is dead → 401", `HTTP ${r.status}`);
    } else {
        console.log(`  ⊘ disconnect not available via plt (HTTP ${dis.status}); skipping revocation check`);
    }
} catch (e) {
    bad("e2e", e.message);
} finally {
    if (appId) await api("DELETE", `/v1/platform/apps/${appId}`, USER_JWT).catch(() => {});
}
console.log(`\n  Results: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
