import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken } from "@/lib/auth/tokens";
import { deriveInviteStatus, type InviteRow } from "@/lib/governance/invite-guard";
import { AcceptInviteForm } from "@/components/invite/accept-form";
import { Card, CardBody } from "@/components/ui/card";
import { Wordmark } from "@/components/marketing/wordmark";

export const runtime = "nodejs";

/**
 * Public, unauthenticated accept page (L-47/L-48, T7). Reads the invites
 * table directly via the admin client — invites carries deny-all RLS
 * (migration 0039), so no session-scoped client could ever see this row
 * regardless; this is the one narrow, spec-directed exception to "the web
 * UI only calls the API" (there is no public GET-by-token API route in
 * scope for this wave — the page itself performs the read, exactly like a
 * script would, but read-only and never exposing token_hash).
 *
 * Never renders the raw token anywhere except the URL the visitor already
 * has, and never leaks workspace internals beyond the workspace's name and
 * the inviter's label.
 *
 * T3 (F2c-mini) — deliberate asymmetry vs POST /api/invites/accept: that
 * API route collapses not-found/expired/used/revoked into ONE uniform 422
 * message (anti-enumeration — see invite-guard.ts's
 * INVITE_ACCEPT_ERROR_MESSAGE). THIS page keeps its distinct friendly
 * per-status copy below ("expired" vs "already used" vs "revoked" vs "not
 * found") on purpose: it is not a scriptable enumeration surface — the
 * visitor here already holds the exact link and is reading a page, not
 * probing a JSON API with arbitrary tokens.
 */
export default async function InviteAcceptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const db = createAdminClient();
  const tokenHash = hashToken(token);

  const { data: invite } = await db
    .from("invites")
    .select("id, workspace_id, email, revoked, accepted_at, expires_at, created_by")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  let workspaceName: string | null = null;
  let inviterLabel: string | null = null;

  if (invite) {
    const [{ data: workspace }, { data: inviter }] = await Promise.all([
      db.from("workspaces").select("name").eq("id", invite.workspace_id).maybeSingle(),
      db.from("profiles").select("display_name, email").eq("id", invite.created_by).maybeSingle(),
    ]);
    workspaceName = workspace?.name ?? null;
    inviterLabel = inviter?.display_name || inviter?.email || null;
  }

  const status = invite ? deriveInviteStatus(invite as InviteRow) : "not_found";

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Wordmark size="lg" />
          <p className="mt-1 text-sm text-ink-muted">You&apos;ve been invited</p>
        </div>

        <Card>
          <CardBody className="p-6">
            {status === "pending" && invite ? (
              <>
                <h1 className="mb-1 text-base font-medium text-ink">
                  Join {workspaceName ?? "the workspace"}
                </h1>
                <p className="mb-6 text-sm text-ink-secondary">
                  {inviterLabel ? `${inviterLabel} invited you` : "You were invited"} as{" "}
                  <span className="font-medium text-ink">{invite.email}</span>.
                </p>
                <AcceptInviteForm token={token} email={invite.email} />
              </>
            ) : (
              <div className="space-y-4 py-2 text-center">
                <h1 className="text-base font-medium text-ink">
                  {status === "not_found" && "Invite not found"}
                  {status === "expired" && "This invite has expired"}
                  {status === "accepted" && "This invite has already been used"}
                  {status === "revoked" && "This invite has been revoked"}
                </h1>
                <p className="text-sm text-ink-secondary">
                  {status === "not_found"
                    ? "Check the link, or ask for a new one."
                    : status === "accepted"
                      ? "You have already joined. Please sign in."
                      : status === "expired"
                        ? "Invites last 7 days. Ask for a fresh one."
                        : "Ask for a fresh invite."}
                </p>
                <Link
                  href={status === "accepted" && invite?.email ? `/login?email=${encodeURIComponent(invite.email)}` : "/login"}
                  className="focus-ring inline-flex min-h-11 items-center rounded-sm text-sm text-accent hover:underline"
                >
                  Go to sign in →
                </Link>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
