import { FakeDb } from "@/lib/integrations/test-support";

type Row = Record<string, unknown>;
type RpcResult = Awaited<ReturnType<FakeDb["rpc"]>>;

/**
 * Test double for the weekly report's one atomic database call (migration 0110, nopm_weekly_report_store).
 * It mirrors the SQL function: claim the scheduled recipients that have no ledger row this ISO week, store the
 * report and write the audit row, or change nothing at all. Everything else is the shared FakeDb.
 *
 * Knobs for the failure cases:
 *   failAudit  the audit insert fails, so the claim and the report are rolled back with it
 *   loseClaim  a racing tick claimed first: the call answers already_sent and writes nothing
 */
export class WeeklyReportFakeDb extends FakeDb {
  /** Audit rows written by the atomic call, in order (the equivalent of audit_log rows). */
  audits: Row[] = [];
  /** Every nopm_weekly_report_store call, in order. */
  weeklyCalls: Record<string, unknown>[] = [];
  failAudit = false;
  loseClaim = false;

  async rpc(name?: string, args: Record<string, unknown> = {}): Promise<RpcResult> {
    if (name !== "nopm_weekly_report_store") return super.rpc(name, args);
    this.weeklyCalls.push(args);
    const ws = args.p_workspace_id as string;
    const weekStart = args.p_week_start as string;
    const trigger = args.p_trigger as string;
    const wanted = ((args.p_recipients as string[] | null) ?? []).filter((id) =>
      this.rows("profiles").some((p) => p.id === id && p.workspace_id === ws),
    );

    let recipients: string[];
    const claims: Row[] = [];
    if (trigger === "scheduled") {
      if (this.loseClaim) return { data: { status: "already_sent", recipients: [] }, error: null, count: null } as RpcResult;
      recipients = [...new Set(wanted)].filter(
        (id) =>
          !this.rows("nudge_log").some(
            (n) =>
              n.workspace_id === ws &&
              n.kind === "weekly_report" &&
              n.target_id === ws &&
              n.recipient_id === id &&
              String(n.sent_on) >= weekStart,
          ),
      );
      if (recipients.length === 0) return { data: { status: "already_sent", recipients: [] }, error: null, count: null } as RpcResult;
      for (const id of recipients) {
        claims.push({
          id: this.nextId(),
          workspace_id: ws,
          target_type: "workspace",
          target_id: ws,
          kind: "weekly_report",
          recipient_id: id,
          sent_on: args.p_sent_on,
        });
      }
    } else {
      recipients = [...new Set(wanted)];
    }

    if (this.failAudit) {
      // The audit insert raised: the claim and the report were never committed.
      return { data: null, error: { code: "XX000", message: "audit insert failed" }, count: null } as RpcResult;
    }

    this.seed("nudge_log", claims);
    const existing = this.rows("weekly_reports").find((r) => r.workspace_id === ws && r.week_start === weekStart);
    const report = { data: args.p_snapshot, generated_at: args.p_generated_at, generated_by: args.p_generated_by };
    if (existing) Object.assign(existing, report);
    else this.seed("weekly_reports", [{ id: this.nextId(), workspace_id: ws, week_start: weekStart, ...report }]);

    const audit = (args.p_audit ?? {}) as Row;
    this.audits.push({
      ...audit,
      workspace_id: ws,
      target_id: ws,
      before: null,
      after: { week_start: weekStart, trigger, recipients: recipients.length },
    });
    return { data: { status: "stored", recipients }, error: null, count: null } as RpcResult;
  }
}
