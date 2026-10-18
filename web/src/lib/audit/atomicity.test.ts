import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { libFileNonAtomic, nonAtomicHandlers, verbSpans, walkFiles } from "./atomicity-scan";

/**
 * M1 atomicity (audit finding: about 59 handlers wrote the change first and the audit
 * row afterwards). Text scan over EVERY route handler under src/app/api and EVERY
 * library file under src/lib: no `writeAudit(` may come AFTER a direct insert / update /
 * delete / upsert on the admin client. Such code must use the atomic wrapper
 * (audited-write.ts) or an RPC that audits inside SQL.
 *
 * EXCEPTIONS is the complete, honest list of what is still non-atomic, each with a
 * reason and an owner. An entry that has become atomic fails the build until its line
 * is deleted, so the list can only shrink.
 */

const SRC = join(process.cwd(), "src");
const API_DIR = join(SRC, "app", "api");

type Exception = { reason: string; owner: string };

const ex = (owner: string, reason: string): Exception => ({ owner, reason });

/** "<api path>#<VERB>" for a route, "lib/<path>.ts" for a library file. */
const EXCEPTIONS: Record<string, Exception> = {
  // ── routes ────────────────────────────────────────────────────────────────
  "projects/[id]#DELETE": ex("deletion-flow wave", "inserts a deletion_requests row (maker step of the four-eyes flow, not an allowlisted table), then audits project.delete_requested"),
  "tasks/[id]#DELETE": ex("deletion-flow wave", "inserts a deletion_requests row (maker step of the four-eyes flow, not an allowlisted table), then audits task.delete_requested"),
  "projects/[id]/change-requests#POST": ex("approval-tier wave", "change-request raise: governance path with tier routing, needs its own function"),
  "projects/[id]/rebaselines#POST": ex("approval-tier wave", "rebaseline draft: governance path, needs its own function"),
  "change-requests/[id]#PATCH": ex("approval-tier wave", "edit of a raised change request: update then audit, change_requests is not an allowlisted table"),
  "change-requests/[id]#DELETE": ex("approval-tier wave", "withdraw of a raised change request: status update then audit, change_requests is not an allowlisted table"),
  "auth/mfa/challenge#POST": ex("lead (decision needed)", "writes user_mfa state then audits; user_mfa is per-user security state, not an allowlisted table"),
  "auth/mfa/disable#POST": ex("lead (decision needed)", "writes user_mfa state then audits; user_mfa is per-user security state, not an allowlisted table"),
  "auth/mfa/enroll#POST": ex("lead (decision needed)", "writes user_mfa state then audits; user_mfa is per-user security state, not an allowlisted table"),
  "auth/mfa/verify#POST": ex("lead (decision needed)", "writes user_mfa state then audits; user_mfa is per-user security state, not an allowlisted table"),
  "integrations/connectors#POST": ex("route group 2 agent", "connector create: integration_connectors is allowlisted, the handler still writes then audits"),
  "integrations/connectors/[id]#PATCH": ex("route group 2 agent", "connector update/rotate: integration_connectors is allowlisted, the handler still writes then audits"),
  "integrations/github/connector#POST": ex("work-events wave", "GitHub connector create: writes then audits"),
  "integrations/github/connector#PATCH": ex("work-events wave", "GitHub connector update: writes then audits"),
  "integrations/github/connector#DELETE": ex("work-events wave", "GitHub connector revoke: writes then audits"),
  // ── library writers ───────────────────────────────────────────────────────
  "lib/governance/request-deletion.ts": ex("deletion-flow wave", "the five *.delete_requested writes (risk, issue, expense, document, milestone): deletion_requests insert, then audit"),
  "lib/governance/decide.ts": ex("deletion-flow wave", "withdraw and reopen of deletion requests: status update then audit; the approve path is already an RPC"),
  "lib/assistant/token.ts": ex("route group 2 agent", "mints and revokes the assistant's ephemeral api_tokens row, then audits; api_tokens is allowlisted"),
  "lib/governance/invite-accept.ts": ex("route group 2 agent", "revokes the invite when account creation fails after nopm_accept_invite, then audits; invites is allowlisted"),
  "lib/integrations/identity.ts": ex("route group 2 agent", "link-code consume and external_identities insert / revoke, then audit; external_identities is allowlisted"),
  "lib/clash/detect.ts": ex("lead (follow-up)", "system auto-create and auto-resolve of clashes, then audit; clashes is allowlisted, convert with a system actor"),
  "lib/insight/overspend.ts": ex("lead (follow-up)", "sets the budget overspend level marker, then audits the crossing; project_budget is allowlisted"),
  "lib/insight/snapshots.ts": ex("lead (follow-up)", "nightly project_snapshots upsert, then one audit row for the whole run (system job, not a user change)"),
  "lib/nudges/weekly-report.ts": ex("lead (follow-up)", "stores the weekly report and its nudge claim, then audits the send; weekly_reports and nudge_log are not allowlisted"),
};

function scanAll(): string[] {
  const found: string[] = [];
  for (const f of walkFiles(SRC, /\.ts$/)) {
    const rel = f.split("\\").join("/").split("/src/")[1];
    if (/\.test\.ts$/.test(rel) || rel.includes("test-support") || rel === "lib/audit/atomicity-scan.ts") continue;
    const src = readFileSync(f, "utf8");
    if (rel.startsWith("app/api/") && rel.endsWith("/route.ts")) {
      found.push(...nonAtomicHandlers(src, rel.replace(/^app\/api\//, "").replace(/\/route\.ts$/, "")));
    } else if (rel.startsWith("lib/") && libFileNonAtomic(src)) {
      found.push(rel);
    }
  }
  return found.sort();
}

function pathOf(id: string): string {
  return id.startsWith("lib/") ? join(SRC, id) : join(API_DIR, id.split("#")[0], "route.ts");
}

describe("M1 atomicity: a change and its audit row are written together", () => {
  it("scans the whole code base", () => {
    expect(walkFiles(API_DIR, /^route\.ts$/).length).toBeGreaterThan(80);
  });

  it("no route handler or library writer audits after a direct write, except the listed ones", () => {
    const violations = scanAll().filter((id) => !EXCEPTIONS[id]);
    expect(violations).toEqual([]);
  });

  it("every exception is real, still non-atomic, and has an owner and a reason", () => {
    const found = new Set(scanAll());
    const problems: string[] = [];
    for (const [id, e] of Object.entries(EXCEPTIONS)) {
      if (!existsSync(pathOf(id))) {
        problems.push(`${id}: file does not exist`);
        continue;
      }
      if (!found.has(id)) problems.push(`${id}: is atomic now, delete its line from EXCEPTIONS`);
      if (e.reason.trim().length < 30) problems.push(`${id}: reason too short`);
      if (e.owner.trim().length < 3) problems.push(`${id}: owner missing`);
      if (id.includes("#") && !verbSpans(readFileSync(pathOf(id), "utf8")).some((s) => s.verb === id.split("#")[1])) {
        problems.push(`${id}: no such verb`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("the converted route group uses the wrapper", () => {
    const users = walkFiles(API_DIR, /^route\.ts$/)
      .filter((f) => /audited(?:Insert|Update|Delete)\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.split("\\").join("/").split("src/app/api/")[1].replace(/\/route\.ts$/, ""));
    for (const expected of [
      "projects",
      "projects/[id]",
      "projects/[id]/tasks",
      "projects/[id]/milestones",
      "projects/[id]/risks",
      "projects/[id]/issues",
      "projects/[id]/expenses",
      "projects/[id]/dependencies",
      "projects/[id]/dependencies/[depId]",
      "tasks/[id]",
      "tasks/[id]/dependencies",
      "milestones/[id]",
      "risks/[id]",
      "issues/[id]",
      "clashes",
      "clashes/[id]",
      "programs",
      "programs/[id]",
      "sprints",
      "sprints/[id]",
      "sprints/[id]/start",
      "sprints/[id]/tasks",
      "allocations",
      "allocations/[id]",
      "resources",
      "resources/[id]",
      "saved-views",
      "saved-views/[id]",
      "saved-views/[id]/duplicate",
      "calendar-feeds",
      "calendar-feeds/[id]",
    ]) {
      expect(users, expected).toContain(expected);
    }
  });

  it("the detector sees mutate-then-audit and ignores audit-then-mutate and blocked-attempt audits", () => {
    const bad = [
      "export const PATCH = route(async () => {",
      '  await db.from("tasks").update({ a: 1 }).eq("id", 1);',
      '  await writeAudit({ action: "task.update" });',
      "});",
    ].join("\n");
    const good = [
      "export const PATCH = route(async () => {",
      '  await assertProjectUnlocked(db, 1, 2, () => writeAudit({ action: "task.update.blocked" }));',
      '  const row = await auditedUpdate({ table: "tasks", action: "task.update" });',
      "});",
    ].join("\n");
    expect(nonAtomicHandlers(bad, "tasks/[id]")).toEqual(["tasks/[id]#PATCH"]);
    expect(nonAtomicHandlers(good, "tasks/[id]")).toEqual([]);
    expect(libFileNonAtomic('await db.from("x").insert({});\nawait writeAudit({});')).toBe(true);
    expect(libFileNonAtomic('await writeAudit({});\nawait db.from("x").insert({});')).toBe(false);
  });
});
