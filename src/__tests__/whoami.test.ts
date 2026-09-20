import { afterEach, describe, expect, it, vi } from "vitest";
import { createOneclawPort } from "../oneclaw.js";

// The vault's real /v1/auth/me shape: the user row, no org field, no
// principal_type (non-users are refused with 403 before this point).
const ME = { id: "c9b66e33", email: "kev@example.com", display_name: "Kev", role: "owner", auth_method: "password_argon2" };

function jwt(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "EdDSA" })}.${b64(claims)}.sig`;
}

describe("whoami", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("accepts the vault's real user shape and takes the org from the token", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ME), { status: 200 })));
        const port = createOneclawPort({ baseUrl: "https://api.example", platformApiKey: "plt_x", platformAppId: "app" });
        const me = await port.whoami(jwt({ sub: "user:c9b66e33", org: "org-1", exp: 9999999999 }));
        expect(me).toEqual({ id: "c9b66e33", email: "kev@example.com", org_id: "org-1" });
    });

    it("refuses a token the vault rejects, a non-user principal, and a token with no org", async () => {
        const port = createOneclawPort({ baseUrl: "https://api.example", platformApiKey: "plt_x", platformAppId: "app" });
        vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
        await expect(port.whoami(jwt({ org: "org-1" }))).rejects.toMatchObject({ status: 401 });
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...ME, principal_type: "agent" }), { status: 200 })));
        await expect(port.whoami(jwt({ org: "org-1" }))).rejects.toMatchObject({ status: 401 });
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ME), { status: 200 })));
        await expect(port.whoami(jwt({ sub: "user:x" }))).rejects.toMatchObject({ status: 401 });
    });
});
