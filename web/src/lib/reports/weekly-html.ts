import { BASE_CSS, P, TONE, esc } from "./html";
import type { DigestData } from "@/lib/integrations/types";
import { chainHeadLine, type ChainHead } from "@/lib/audit/chain-head";

/**
 * The weekly status report as a self-contained HTML page (R-142). It renders
 * the SAME digest data the Lark weekly card is built from, plus the stale list,
 * in the style of the portfolio report in html.ts (shared palette and CSS).
 * Pure: a stored snapshot in, a string out. Everything user-supplied is escaped.
 */

export type WeeklySnapshotStale = {
  kind: "task" | "risk" | "issue";
  title: string;
  projectCode: string | null;
  projectName: string | null;
  daysStale: number;
};

export type WeeklySnapshot = {
  /** Monday of the ISO week, YYYY-MM-DD, in the workspace time zone. */
  weekStart: string;
  digest: DigestData;
  staleDays: number;
  /** Stalest first, capped when stored. */
  stale: WeeklySnapshotStale[];
  /** Newest audit row hash when the snapshot was built (R-154); absent on older snapshots. */
  chainHead?: ChainHead | null;
};

const cap = (s: string) => s.replace(/_/g, " ");

function dot(health: string | null): string {
  const c = TONE[health ?? ""] ?? P.muted;
  return `<span class="dot" style="background:${c}"></span>`;
}

export function renderWeeklyReportHtml(snap: WeeklySnapshot): string {
  const d = snap.digest;
  const stale = d.staleItems ?? snap.stale.length;

  const cover = `<div class="cover">
      <div class="subtitle">${esc(d.workspaceName)}</div>
      <h1>Weekly status report</h1>
      <div class="ts">Week of ${esc(snap.weekStart)} &middot; generated ${esc(new Date(d.generatedAt).toUTCString())} &middot; NoPM</div>${
      chainHeadLine(snap.chainHead) ? `
      <div class="ts" style="font-family:monospace;font-size:11px;word-break:break-all">${esc(chainHeadLine(snap.chainHead) as string)}</div>` : ""
    }
    </div>`;

  const cards = `<div class="cards">
      <div class="card"><div class="num">${d.projects.length}</div><div class="lbl">Projects</div></div>
      <div class="card"><div class="num" style="color:${d.openHighRisks > 0 ? P.red : P.ink}">${d.openHighRisks}</div><div class="lbl">Open high risks</div></div>
      <div class="card"><div class="num" style="color:${d.pendingApprovals > 0 ? P.amber : P.ink}">${d.pendingApprovals}</div><div class="lbl">Pending approvals</div></div>
      <div class="card"><div class="num" style="color:${stale > 0 ? P.amber : P.ink}">${stale}</div><div class="lbl">Stale items (${snap.staleDays}+ days)</div></div>
    </div>`;

  const projects =
    d.projects.length === 0
      ? `<h2>Projects</h2><p class="reg">No projects yet.</p>`
      : `<h2>Projects</h2><table><thead><tr><th>Code</th><th>Project</th><th>Health</th><th>Status</th></tr></thead><tbody>${d.projects
          .map(
            (p) =>
              `<tr><td>${esc(p.code ?? "—")}</td><td>${esc(p.name)}</td><td>${dot(p.health)}${esc(cap(p.health ?? "—"))}</td><td>${esc(cap(p.status ?? "—"))}</td></tr>`,
          )
          .join("")}</tbody></table>`;

  const milestones =
    d.milestonesDueSoon.length === 0
      ? `<h2>Milestones due soon</h2><p class="reg">Nothing due in the next two weeks.</p>`
      : `<h2>Milestones due soon</h2><table><thead><tr><th>Milestone</th><th>Project</th><th>Due</th></tr></thead><tbody>${d.milestonesDueSoon
          .map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.projectName ?? "—")}</td><td>${esc(m.dueDate)}</td></tr>`)
          .join("")}</tbody></table>`;

  const staleSection =
    snap.stale.length === 0
      ? `<h2>Stale items</h2><p class="reg">No open task, risk or issue has gone ${snap.staleDays}+ days without an update.</p>`
      : `<h2>Stale items</h2><table><thead><tr><th>Project</th><th>Type</th><th>Item</th><th>Days since update</th></tr></thead><tbody>${snap.stale
          .map(
            (s) =>
              `<tr><td>${esc(s.projectCode ?? s.projectName ?? "—")}</td><td>${esc(s.kind)}</td><td>${esc(s.title)}</td><td>${s.daysStale}</td></tr>`,
          )
          .join("")}</tbody></table>${
          stale > snap.stale.length ? `<p class="reg">Showing the ${snap.stale.length} stalest of ${stale}.</p>` : ""
        }`;

  const emergency = d.emergencyChanges;
  const emergencySection =
    !emergency || emergency.count === 0
      ? `<h2>Emergency changes this week: 0</h2><p class="reg">No emergency change was raised this week.</p>`
      : `<h2>Emergency changes this week: ${emergency.count}</h2><p class="reg">Each one committed when it was raised, without an approver, and is flagged here.</p><table><thead><tr><th>Reference</th><th>Change</th></tr></thead><tbody>${emergency.items
          .map((i) => `<tr><td>${esc(i.reference ?? "—")}</td><td><span style="color:${P.red};font-weight:600">Emergency</span> ${esc(i.title)}</td></tr>`)
          .join("")}</tbody></table>${
          emergency.count > emergency.items.length ? `<p class="reg">Showing ${emergency.items.length} of ${emergency.count}.</p>` : ""
        }`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.workspaceName)} — Weekly status</title>
<style>${BASE_CSS}
  @media (max-width:640px){.wrap{padding:24px 16px}.cover{padding:28px 20px;min-height:180px}.cover h1{font-size:28px}table{display:block;overflow-x:auto}}
</style></head><body><div class="wrap">
${cover}
${cards}
${projects}
${milestones}
${staleSection}
${emergencySection}
<div class="foot">Governed by NoPM — every change behind this report is captured in an immutable audit log.</div>
</div></body></html>`;
}
