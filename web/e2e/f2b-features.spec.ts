import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { ADMIN_STATE, SHELL_MARKER } from "./helpers";

// F2b closing spec (T8, f2b-specs.md — LEAN-MODE TRIM, owner decision
// 2026-08-15). Same Tier-1 idiom as f2a-features.spec.ts: admin
// storageState, SHELL_MARKER for "real console chrome rendered", skip (not
// fail) when Supabase env wasn't available to mint the admin session, and a
// precondition-driven `test.skip` rather than a fabricated fixture wherever
// a journey depends on seeded data this spec cannot create itself.
//
// Three journeys in this file perform REAL governed writes (sprint
// create->start->close, a timesheet submit + self-decision probe, an invite
// create->revoke) — playwright.config.ts documents this repo's existing
// two-tier convention ("Tier 2 (E2E_WRITES=1) — write journeys ... with
// cleanup"), so each write test is individually gated on E2E_WRITES=1
// rather than folding untiered writes into a file whose describe block
// otherwise runs by default. A default `npm run test:e2e` (no E2E_WRITES)
// therefore stays fully read-only for this file, same as every Tier-1 spec
// in this directory; set E2E_WRITES=1 to exercise the write-tier journeys.
// Written data is NOT cleaned up (sprints/timesheet submissions/invites have
// no unconditional delete path by design — governed snapshots and a
// revoked-not-deleted invite are the intended terminal states), mirroring
// the "mint and revoke a PAT" write test in writes.spec.ts, which leaves its
// revoked token row behind on the same reasoning.

test.describe("f2b admin-authenticated journeys", () => {
  test.use({ storageState: ADMIN_STATE });
  test.skip(!existsSync(ADMIN_STATE), "admin storage state not minted (Supabase env missing)");

  const STAMP = `e2e-f2b-${Date.now()}`;
  let createdSprintId: string | undefined;

  // ── sidebar links (T8: "verify sidebar links exist") ─────────────────────

  test.describe("sidebar links (D10)", () => {
    test("sidebar exposes /sprints and /timesheets links (sidebar-links-f2b)", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('nav a[href="/sprints"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/timesheets"]').first()).toBeVisible();
    });
  });

  // ── (1) sprint lifecycle (L-17/L-18/L-19/L-20) ────────────────────────────

  test.describe("sprint lifecycle (L-17/L-18/L-19/L-20)", () => {
    test("/sprints renders the console shell, with an EmptyState when the register is empty (sprints-page-smoke)", async ({
      page,
    }) => {
      const totalRes = await page.request.get("/api/sprints?limit=1");
      expect(totalRes.ok()).toBeTruthy();
      const total = (await totalRes.json()).total as number;

      await page.goto("/sprints");
      await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("heading", { name: "Sprints", exact: true })).toBeVisible();

      if (total === 0) {
        await expect(
          page.getByText("No sprints yet. Create a sprint under a project to plan and track commitment."),
        ).toBeVisible();
      } else {
        await expect(page.getByRole("button", { name: /^new sprint$/i })).toBeVisible();
      }
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    });

    test("sprint create -> start -> close drives the governed state machine and snapshots points (sprint-create-and-commit)", async ({
      page,
    }) => {
      test.skip(!process.env.E2E_WRITES, "write journey is opt-in: set E2E_WRITES=1");

      const projectsRes = await page.request.get("/api/projects?limit=1");
      expect(projectsRes.ok()).toBeTruthy();
      const project = (await projectsRes.json()).data[0];
      test.skip(!project, "no seeded project to attach a sprint to");

      const today = new Date().toISOString().slice(0, 10);
      const end = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);

      const createRes = await page.request.post("/api/sprints", {
        data: {
          project_id: project.id,
          name: `E2E Sprint ${STAMP}`,
          start_date: today,
          end_date: end,
        },
      });
      expect(createRes.status()).toBe(201);
      const sprint = (await createRes.json()).data;
      expect(sprint.state).toBe("planned");
      createdSprintId = sprint.id;

      const startRes = await page.request.post(`/api/sprints/${sprint.id}/start`);
      expect(startRes.ok()).toBeTruthy();
      const started = (await startRes.json()).data;
      expect(started.state).toBe("active");
      expect(started.committed_points).not.toBeNull();

      // planned -> active is one-way; starting an already-active sprint 422s.
      const restart = await page.request.post(`/api/sprints/${sprint.id}/start`);
      expect(restart.status()).toBe(422);

      const closeRes = await page.request.post(`/api/sprints/${sprint.id}/close`);
      expect(closeRes.ok()).toBeTruthy();
      const closed = (await closeRes.json()).data;
      expect(closed.state).toBe("closed");
      expect(closed.completed_points).not.toBeNull();

      // active -> closed is one-way too; closing an already-closed sprint 422s.
      const reclose = await page.request.post(`/api/sprints/${sprint.id}/close`);
      expect(reclose.status()).toBe(422);
    });
  });

  // ── (2) timesheet four-eyes guard symmetry (L-31) [HIGH RISK, D2] ─────────

  test.describe("timesheet four-eyes guard symmetry (L-31)", () => {
    test("self-decision is blocked on BOTH approve and reject (timesheet-four-eyes-approval)", async ({
      page,
    }) => {
      test.skip(!process.env.E2E_WRITES, "write journey is opt-in: set E2E_WRITES=1");

      const projectsRes = await page.request.get("/api/projects?limit=1");
      expect(projectsRes.ok()).toBeTruthy();
      const project = (await projectsRes.json()).data[0];
      test.skip(!project, "no seeded project to log time against");

      const membersRes = await page.request.get("/api/resources?limit=1");
      expect(membersRes.ok()).toBeTruthy();
      const member = (await membersRes.json()).data[0];
      test.skip(!member, "no seeded resource member to submit a timesheet for");

      // A Monday far enough in the past to be collision-free across repeated
      // runs (offset derived from the current second, not a fixed date) —
      // the DB's partial-unique-index dupe guard would otherwise 422 a
      // second run that reused the same week.
      const weeksBack = 900 + (Math.floor(Date.now() / 1000) % 5000);
      const today = new Date();
      const thisMondayUtc = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
      );
      thisMondayUtc.setUTCDate(thisMondayUtc.getUTCDate() - ((thisMondayUtc.getUTCDay() + 6) % 7));
      thisMondayUtc.setUTCDate(thisMondayUtc.getUTCDate() - weeksBack * 7);
      const periodStart = thisMondayUtc.toISOString().slice(0, 10);

      // At least one time entry in the period is required to submit.
      const entryRes = await page.request.post("/api/time-entries", {
        data: {
          member_id: member.id,
          project_id: project.id,
          entry_date: periodStart,
          hours: 2,
          note: `e2e timesheet ${STAMP}`,
        },
      });
      expect(entryRes.status()).toBe(201);

      const submitRes = await page.request.post("/api/timesheet-submissions", {
        data: { member_id: member.id, period_start: periodStart },
      });
      expect(submitRes.status()).toBe(201);
      const submission = (await submitRes.json()).data;
      expect(submission.status).toBe("submitted");

      // Guard symmetry (D2): the submitter — this same admin session — may
      // not decide their own submission, on EITHER verb.
      const selfApprove = await page.request.post(
        `/api/timesheet-submissions/${submission.id}/decision`,
        { data: { decision: "approved" } },
      );
      expect(selfApprove.status()).toBe(403);

      const selfReject = await page.request.post(
        `/api/timesheet-submissions/${submission.id}/decision`,
        { data: { decision: "rejected", rationale: "e2e self-reject probe" } },
      );
      expect(selfReject.status()).toBe(403);

      // Neither blocked attempt mutated the row — still 'submitted'.
      const after = await page.request.get(
        `/api/timesheet-submissions?member_id=${member.id}&status=submitted&limit=100`,
      );
      expect(after.ok()).toBeTruthy();
      expect(
        (await after.json()).data.some((s: { id: string }) => s.id === submission.id),
      ).toBe(true);
    });
  });

  // ── (3) link invite lifecycle + badtoken page (L-47/L-48) [HIGH RISK] ─────

  test.describe("link invite lifecycle (L-47/L-48)", () => {
    test("invite create -> list shows pending -> revoke, never exposing the token hash (invite-lifecycle)", async ({
      page,
    }) => {
      test.skip(!process.env.E2E_WRITES, "write journey is opt-in: set E2E_WRITES=1");

      const email = `e2e-invite-${STAMP}@example.com`;
      const createRes = await page.request.post("/api/invites", {
        data: { email, role: "member" },
      });
      expect(createRes.status()).toBe(201);
      const invite = (await createRes.json()).data;
      expect(invite.status).toBe("pending");
      expect(typeof invite.invite_url).toBe("string");
      expect(invite.invite_url).toContain("/invite/");
      expect(invite).not.toHaveProperty("token_hash");

      const listRes = await page.request.get("/api/invites?status=pending&limit=100");
      expect(listRes.ok()).toBeTruthy();
      expect(
        (await listRes.json()).data.some((i: { id: string }) => i.id === invite.id),
      ).toBe(true);

      const revokeRes = await page.request.post(`/api/invites/${invite.id}/revoke`);
      expect(revokeRes.ok()).toBeTruthy();
      expect((await revokeRes.json()).data.status).toBe("revoked");

      const revokedListRes = await page.request.get("/api/invites?status=revoked&limit=100");
      expect(revokedListRes.ok()).toBeTruthy();
      expect(
        (await revokedListRes.json()).data.some((i: { id: string }) => i.id === invite.id),
      ).toBe(true);

      // Revoked is terminal — revoking twice is a clean 422, not a 500.
      const rerevoke = await page.request.post(`/api/invites/${invite.id}/revoke`);
      expect(rerevoke.status()).toBe(422);
    });

    test("/invite/badtoken renders a clean invalid-invite error (invite-badtoken-page)", async ({
      page,
    }) => {
      await page.goto("/invite/badtoken");
      await expect(page.getByRole("heading", { name: /invite not found/i })).toBeVisible();
      await expect(page.getByRole("link", { name: /go to sign in/i })).toBeVisible();
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    });
  });

  // ── (4) render smoke: /timesheets grid+report, /sprints Flow card ────────

  test.describe("timesheets + sprints render smoke", () => {
    test("/timesheets renders the week grid and time report (timesheets-page-smoke)", async ({
      page,
    }) => {
      const membersRes = await page.request.get("/api/resources?limit=1");
      expect(membersRes.ok()).toBeTruthy();
      const memberTotal = (await membersRes.json()).total as number;

      await page.goto("/timesheets");
      await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("heading", { name: "Timesheets", exact: true })).toBeVisible();

      if (memberTotal === 0) {
        await expect(
          page.getByText(
            "No team members yet. Add a resource member on the Resources page before logging time.",
          ),
        ).toBeVisible();
      } else {
        await expect(page.getByRole("heading", { name: "Week grid" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Time report", exact: true })).toBeVisible();
      }
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    });

    test("Flow card renders on /sprints for a selected sprint (sprints-flow-card)", async ({
      page,
    }) => {
      const sprintsRes = await page.request.get("/api/sprints?limit=1");
      expect(sprintsRes.ok()).toBeTruthy();
      const sprintId = createdSprintId ?? (await sprintsRes.json()).data?.[0]?.id;
      test.skip(!sprintId, "no sprint available to select (write journey skipped and none seeded)");

      await page.goto(`/sprints?sprint=${sprintId}`);
      await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("heading", { name: "Flow", exact: true })).toBeVisible();
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    });
  });

  // ── (5) first-run wizard absence on a workspace that already has projects ─
  // (L-45, D7 — verify-as-funnel-identity: canWrite is gated server-side, but
  // this probe only needs to prove the wizard's own mount condition —
  // projects.length === 0 — correctly hides it once real data exists.)

  test.describe("first-run wizard absence (L-45)", () => {
    test("wizard does not render on the seeded workspace once projects exist (wizard-absent-with-projects)", async ({
      page,
    }) => {
      const projectsRes = await page.request.get("/api/projects?limit=1");
      expect(projectsRes.ok()).toBeTruthy();
      const total = (await projectsRes.json()).total as number;
      test.skip(total === 0, "workspace has zero projects — wizard SHOULD show here, not a defect");

      await page.goto("/dashboard");
      await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
      // Confirms the real (non-empty) portfolio path rendered, not the empty
      // state the wizard would otherwise be nested inside.
      await expect(page.getByRole("heading", { name: "Portfolio", exact: true })).toBeVisible();
      await expect(page.getByText(/get started · step/i)).toHaveCount(0);
      await expect(page.getByLabel("Dismiss setup guide")).toHaveCount(0);
    });
  });
}); // end "f2b admin-authenticated journeys"
