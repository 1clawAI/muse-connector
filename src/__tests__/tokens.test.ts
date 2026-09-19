import { describe, it, expect } from "vitest";
import { mintToken, verifyToken, TOKEN_PREFIX } from "../tokens.js";

const SECRET = "s".repeat(40);
const CID = "8f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7";

describe("connector tokens", () => {
    it("round-trip", () => {
        const t = mintToken(SECRET, CID);
        expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
        const v = verifyToken(SECRET, t);
        expect(v.ok && v.payload.cid).toBe(CID);
    });
    it("rejects a different secret, a tampered body, an expired token, and foreign prefixes", () => {
        const t = mintToken(SECRET, CID);
        expect(verifyToken("x".repeat(40), t).ok).toBe(false);
        const [body, sig] = t.slice(TOKEN_PREFIX.length).split(".");
        const tampered = `${TOKEN_PREFIX}${Buffer.from(JSON.stringify({ cid: "00000000-0000-4000-8000-000000000000", iat: 1, exp: 9e9, jti: "x" })).toString("base64url")}.${sig}`;
        expect(verifyToken(SECRET, tampered).ok).toBe(false);
        expect(verifyToken(SECRET, `${TOKEN_PREFIX}${body}.AAAA`).ok).toBe(false);
        const old = mintToken(SECRET, CID, 10, Date.now() - 60_000);
        expect(verifyToken(SECRET, old)).toEqual({ ok: false, reason: "expired" });
        for (const foreign of ["ocv_abc", "1ck_abc", "plt_abc", "Bearer x", ""]) {
            expect(verifyToken(SECRET, foreign).ok).toBe(false);
        }
    });
    it("refuses a weak secret at mint time", () => {
        expect(() => mintToken("short", CID)).toThrow();
    });
});
