/**
 * "Open" register statuses, in ONE place.
 *
 * The dashboard KPI, the project dossier, the portfolio tile and the project
 * Overview all say "open risks / open issues". They must agree on what open
 * means, so the status sets live here instead of being re-typed per page.
 *
 * Risk statuses (api/risks/_schema.ts):  open | mitigating | accepted | closed
 * Issue statuses (api/issues/_schema.ts): open | in_progress | resolved | closed
 *
 * Open = still needs someone's attention: a risk that is `open` or being
 * `mitigating`; an issue that is `open` or `in_progress`. `accepted`,
 * `closed` and `resolved` are not open.
 */

export const OPEN_RISK_STATUSES = ["open", "mitigating"] as const;
export const OPEN_ISSUE_STATUSES = ["open", "in_progress"] as const;

export function isOpenRisk(status: string | null | undefined): boolean {
  return (OPEN_RISK_STATUSES as readonly string[]).includes(status ?? "");
}

export function isOpenIssue(status: string | null | undefined): boolean {
  return (OPEN_ISSUE_STATUSES as readonly string[]).includes(status ?? "");
}

export function countOpenRisks(rows: ReadonlyArray<{ status: string | null }>): number {
  return rows.filter((r) => isOpenRisk(r.status)).length;
}

export function countOpenIssues(rows: ReadonlyArray<{ status: string | null }>): number {
  return rows.filter((r) => isOpenIssue(r.status)).length;
}
