import { route } from "@/lib/api/handler";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { generateToken } from "@/lib/auth/tokens";
import { DEMO_RESTRICTED_MESSAGE, isDemoActor } from "@/lib/auth/demo";
import { ConflictError, ScopeError } from "@/lib/api/errors";
import { assertCanManageInvites, assertRoleWithinCap, deriveInviteStatus } from "@/lib/governance/invite-guard";
import { createInviteSchema } from "./_schema";

export const runtime = "nodejs";

const INVITE_TOKEN_PREFIX = "npi_"; // D13 (f2b-specs.md) — distinct from api_tokens' npm_
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Columns returned to callers — token_hash is NEVER included (mirrors
// api/tokens/route.ts's SAFE_COLUMNS precedent).
const SAFE_COLUMNS =
  "id, email, role, name, role_title, cost_rate, capacity_hours_per_week, prefix, created_by, created_at, expires_at, revoked, accepted_at, accepted_profile_id" as const;

type InviteRow = {
  id: string;
  email: string;
  role: string;
  name: string | null;
  role_title: string | null;
  cost_rate: number;
  capacity_hours_per_week: number;
  prefix: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  revoked: boolean;
  accepted_at: string | null;
  accepted_profile_id: string | null;
};

function withStatus(row: InviteRow) {
  return { ...row, status: deriveInviteStatus(row) };
}

const STATUS_FILTERS = ["pending", "accepted", "revoked", "expired"] as const;

// GET /api/invites — list this workspace's invites (admin/manager session only, D5).
export const GET = route(async ({ actor, request }) => {
  assertCanManageInvites(actor);

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10) || 20));
  const offset = (page - 1) * limit;

  const statusFilter = searchParams.get("status");
  if (statusFilter && !(STATUS_FILTERS as readonly string[]).includes(statusFilter)) {
    return validationError("Invalid status filter", [
      { field: "status", message: `must be one of ${STATUS_FILTERS.join(", ")}` },
    ]);
  }

  const db = createAdminClient();
  const nowIso = new Date().toISOString();

  // status is DERIVED (migration 0039 header), not a stored column — but
  // each derived value maps onto an exact, mutually-exclusive combination
  // of the three source columns, so the filter is still pushed down to the
  // query (inline on both the count and data builders — the house TS2589
  // workaround) rather than fetched-then-filtered, which would silently
  // break pagination (a page could come back short even though later pages
  // still had matches). Mirrors deriveInviteStatus's own precedence:
  // revoked wins over accepted, which wins over expired.
  let countQuery = db.from("invites").select("id", { count: "exact", head: true }).eq("workspace_id", actor.workspaceId);
  let query = db
    .from("invites")
    .select(SAFE_COLUMNS)
    .eq("workspace_id", actor.workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (statusFilter === "revoked") {
    countQuery = countQuery.eq("revoked", true);
    query = query.eq("revoked", true);
  } else if (statusFilter === "accepted") {
    countQuery = countQuery.eq("revoked", false).not("accepted_at", "is", null);
    query = query.eq("revoked", false).not("accepted_at", "is", null);
  } else if (statusFilter === "expired") {
    countQuery = countQuery.eq("revoked", false).is("accepted_at", null).lte("expires_at", nowIso);
    query = query.eq("revoked", false).is("accepted_at", null).lte("expires_at", nowIso);
  } else if (statusFilter === "pending") {
    countQuery = countQuery.eq("revoked", false).is("accepted_at", null).gt("expires_at", nowIso);
    query = query.eq("revoked", false).is("accepted_at", null).gt("expires_at", nowIso);
  }

  const { count, error: countError } = await countQuery;
  if (countError) throw countError;

  const { data, error } = await query;
  if (error) throw error;

  const rows = ((data ?? []) as InviteRow[]).map(withStatus);

  return okList(rows, { total: count ?? 0, page, limit });
});

// POST /api/invites — mint a new link invite (admin/manager session only, D5).
export const POST = route(async ({ actor, request }) => {
  assertCanManageInvites(actor);
  // A1-3 / A2-2: the shared public demo login must not mint invites.
  if (await isDemoActor(actor)) throw new ScopeError(DEMO_RESTRICTED_MESSAGE, "demo_restricted");

  const body = await safeJson(request);
  const parsed = createInviteSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  // D5 role-escalation cap: invite.role must be <= the creator's own rank.
  assertRoleWithinCap(actor.role ?? "", parsed.data.role);

  const db = createAdminClient();

  // D-ACC-15: someone who already has an account in this workspace cannot be
  // invited again (accepting would only fail later with "email already exists").
  // ilike with the wildcard characters escaped = a case-insensitive exact match.
  const emailPattern = parsed.data.email.replace(/[\\%_]/g, (c) => "\\" + c);
  const { data: existingAccount, error: accountError } = await db
    .from("profiles")
    .select("id")
    .eq("workspace_id", actor.workspaceId)
    .ilike("email", emailPattern)
    .limit(1)
    .maybeSingle();
  if (accountError) throw accountError;
  if (existingAccount) {
    throw new ConflictError("This email already has an account. Ask them to sign in instead.", "account_exists");
  }

  // Pre-check: an existing PENDING invite for this email already covers the
  // same intent (clean 422 — the DB has no unique index for this, so this
  // pre-check is best-effort, not TOCTOU-safe; acceptable here since two
  // invites for the same email racing to be created is a benign duplicate,
  // not a governance hazard the way a double-committed deletion would be).
  const { data: existingPending } = await db
    .from("invites")
    .select("id, revoked, accepted_at, expires_at")
    .eq("workspace_id", actor.workspaceId)
    .eq("email", parsed.data.email)
    .eq("revoked", false)
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (existingPending) {
    return validationError("A pending invite already exists for this email", [
      { field: "email", message: "a pending invite already exists for this email" },
    ]);
  }

  const { raw, hash, prefix } = generateToken(INVITE_TOKEN_PREFIX);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { data: row, error } = await db
    .from("invites")
    .insert({
      workspace_id: actor.workspaceId,
      email: parsed.data.email,
      role: parsed.data.role,
      name: parsed.data.name ?? null,
      role_title: parsed.data.role_title ?? null,
      cost_rate: parsed.data.cost_rate ?? 0,
      capacity_hours_per_week: parsed.data.capacity_hours_per_week ?? 40,
      token_hash: hash,
      prefix,
      created_by: actor.id,
      expires_at: expiresAt,
    })
    .select(SAFE_COLUMNS)
    .single();

  if (error) throw error;

  // Audit the invite's creation — NEVER the token/hash (mirrors token.create).
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "invite.created",
    targetType: "invite",
    targetId: row.id,
    before: null,
    after: { email: row.email, role: row.role },
  });

  const origin = new URL(request.url).origin;

  // raw token is returned ONCE here (embedded in the invite_url) and never
  // stored/logged anywhere else — same show-once contract as api/tokens.
  return created({ ...withStatus(row as InviteRow), invite_url: `${origin}/invite/${raw}` });
});
