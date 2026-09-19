/**
 * 1Claw has two approval queues a person decides: consensus "pending
 * approvals" (control-plane actions, transactions over a threshold — carry a
 * `payload_hash` the decision must echo) and agent "action approvals"
 * (an agent asking permission to do something, with a human-readable
 * summary). Muse should not have to know which is which, so both come out
 * in one shape with a `kind` for the decide call to route on.
 */
export type ApprovalKind = "consensus" | "agent_action";

export interface NormalizedApproval {
    id: string;
    kind: ApprovalKind;
    status: string;
    /** One line a person can decide on. */
    summary: string;
    /** Free-form detail for follow-up questions. */
    details: Record<string, unknown>;
    risk_tier?: number;
    requested_by?: string;
    created_at?: string;
    expires_at?: string;
    /** consensus only — echoed on decide so the decision binds to what was shown. */
    payload_hash?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export function normalizeApproval(kind: ApprovalKind, raw: Record<string, unknown>): NormalizedApproval {
    const id = str(raw.id) ?? "";
    const status = normalizeStatus(str(raw.status));
    if (kind === "consensus") {
        const payload = (raw.action_payload ?? raw.payload ?? {}) as Record<string, unknown>;
        const action = str(payload.action_type) ?? str(raw.action_type) ?? str(raw.action) ?? "action";
        const summary = str(raw.summary) ?? str(raw.description) ?? describeConsensus(action, payload);
        return {
            id,
            kind,
            status,
            summary,
            details: payload,
            risk_tier: num(raw.risk_tier),
            requested_by: str(raw.submitter_id) ?? str(raw.requested_by) ?? str(raw.submitter_type),
            created_at: str(raw.created_at),
            expires_at: str(raw.expires_at),
            payload_hash: str(raw.payload_hash),
        };
    }
    const summary = str(raw.summary) ?? str(raw.title) ?? str(raw.human_summary) ?? str(raw.description) ?? `${str(raw.action_type) ?? "request"} from an agent`;
    const details: Record<string, unknown> = { ...(raw.details as Record<string, unknown> | undefined), action_type: raw.action_type, payload: raw.payload };
    return {
        id,
        kind,
        status,
        summary,
        details,
        risk_tier: num(raw.risk_tier),
        requested_by: str(raw.agent_name) ?? str(raw.agent_id) ?? str(raw.requester_id),
        created_at: str(raw.created_at),
        expires_at: str(raw.expires_at),
    };
}

function normalizeStatus(s?: string): string {
    if (!s) return "pending";
    if (s === "approved" || s === "approve") return "approved";
    if (s === "denied" || s === "rejected" || s === "reject" || s === "deny") return "rejected";
    return s;
}

function describeConsensus(action: string, payload: Record<string, unknown>): string {
    const to = str(payload.to) ?? str(payload.recipient);
    const value = str(payload.value) ?? str(payload.amount);
    const chain = str(payload.chain);
    if (to && value) return `${action}: send ${value}${chain ? ` on ${chain}` : ""} to ${to}`;
    const name = str(payload.name) ?? str(payload.agent_name) ?? str(payload.path);
    return name ? `${action}: ${name}` : action.replace(/[._]/g, " ");
}
