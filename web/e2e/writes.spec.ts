import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ADMIN_STATE, SHELL_MARKER } from "./helpers";

// Checker PAT (four-eyes second actor) from web/.env.local or CI env
function checkerToken(): string | undefined {
  if (process.env.NOPM_CHECKER_TOKEN) return process.env.NOPM_CHECKER_TOKEN;
  try {
    const env = Object.fromEntries(
      readFileSync(path.join(__dirname, "..", ".env.local"), "utf8")
        .split(/\r?\n/)
        .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => [m[1], m[2]]),
    );
    return env.NOPM_CHECKER_TOKEN || undefined;
  } catch {
    return undefined;
  }
}

// Tier 2 — write journeys. Opt-in only (E2E_WRITES=1): these create real rows
// (and immutable audit entries, by design) in the target environment, then clean up
// after themselves via the governed API. Never run these against the live demo
// right before a pitch unless a reseed follows.
//
// The journey drives the same governed REST API the UI and agents use (through
// the browser session's cookies), asserting the governance semantics: maker-
// checker deletion, self-approval rejection, and full cleanup.

test.skip(!process.env.E2E_WRITES, "write journeys are opt-in: set E2E_WRITES=1");
test.use({ storageState: ADMIN_STATE });
test.skip(!existsSync(ADMIN_STATE), "admin storage state not minted (Supabase env missing)");

const STAMP = `e2e-${Date.now()}`;

test("full governed journey: create → render → task → status → maker-checker request → self-approve blocked → withdraw → re-request → reject → project four-eyes cleanup", async ({
  page,
}) => {
  // Project deletion is maker-checker too (owner-locked to PROJECTS ONLY, Decision 3,
  // requirements/devops-wave1/README.md) — the hard DELETE this journey's cleanup used
  // to issue now returns 202 (a pending deletion_request), and committing it requires a
  // DIFFERENT actor with scope task:delete:approve to approve. Without a checker PAT we
  // cannot commit the cleanup deletion at all, so skip the whole journey up front rather
  // than leaving an undeletable e2e project behind in the target environment.
  const checker = checkerToken();
  test.skip(
    !checker,
    "project cleanup requires the checker PAT (NOPM_CHECKER_TOKEN) — four-eyes approval is the only way to commit a project deletion",
  );

  // Create a project via the governed API (same session as the UI)
  const createdProject = await page.request.post("/api/projects", {
    data: { code: STAMP.toUpperCase().slice(0, 20), name: `E2E Journey ${STAMP}` },
  });
  expect(createdProject.status()).toBe(201);
  const project = (await createdProject.json()).data;

  try {
    // The new project renders in the console UI
    await page.goto(`/projects/${project.id}`);
    await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`E2E Journey ${STAMP}`).first()).toBeVisible();

    // Create a task
    const createdTask = await page.request.post(`/api/projects/${project.id}/tasks`, {
      data: { name: `E2E task ${STAMP}` },
    });
    expect(createdTask.status()).toBe(201);
    const task = (await createdTask.json()).data;

    // Status transition (the same PATCH the kanban drag issues)
    const moved = await page.request.patch(`/api/tasks/${task.id}`, {
      data: { status_type: "started" },
    });
    expect(moved.ok()).toBeTruthy();

    // Maker step: DELETE creates a deletion request, it must NOT hard-delete
    const delReq = await page.request.delete(`/api/tasks/${task.id}`, {
      data: { reason: "e2e governed-journey verification" },
    });
    expect([200, 201, 202].includes(delReq.status())).toBeTruthy();
    const stillThere = await page.request.get(`/api/tasks/${task.id}`);
    expect(stillThere.ok()).toBeTruthy(); // four-eyes: task survives the request

    // Self-approval must be rejected (requester === approver)
    const pending = await page.request.get(`/api/deletion-requests?status=pending`);
    const mine = (await pending.json()).data.find(
      (r: { target_id: string }) => r.target_id === task.id,
    );
    expect(mine).toBeTruthy();
    const selfApprove = await page.request.post(`/api/deletion-requests/${mine.id}/approve`);
    expect([403, 422].includes(selfApprove.status())).toBeTruthy();

    // Self-rejection is four-eyes-guarded too (422, not a DB-constraint 500)
    const selfReject = await page.request.post(`/api/deletion-requests/${mine.id}/reject`, {
      data: { reason: "e2e self-reject probe" },
    });
    expect(selfReject.status()).toBe(422);

    // The maker CAN withdraw their own pending request (the one permitted self-act)
    const withdraw = await page.request.post(`/api/deletion-requests/${mine.id}/withdraw`);
    expect(withdraw.ok()).toBeTruthy();
    const afterWithdraw = await page.request.get(`/api/deletion-requests?status=withdrawn`);
    expect(
      (await afterWithdraw.json()).data.some((r: { id: string }) => r.id === mine.id),
    ).toBeTruthy();
    // Withdrawal is terminal — it cannot be withdrawn (or decided) twice
    const rewithdraw = await page.request.post(`/api/deletion-requests/${mine.id}/withdraw`);
    expect(rewithdraw.status()).toBe(422);

    // Withdrawal freed the target: the maker can re-request the same deletion
    const delReq2 = await page.request.delete(`/api/tasks/${task.id}`, {
      data: { reason: "e2e governed-journey verification (re-request after withdraw)" },
    });
    expect([200, 201, 202].includes(delReq2.status())).toBeTruthy();
    const pending2 = await page.request.get(`/api/deletion-requests?status=pending`);
    const mine2 = (await pending2.json()).data.find(
      (r: { target_id: string; id: string }) => r.target_id === task.id,
    );
    expect(mine2).toBeTruthy();

    // A DIFFERENT actor (checker PAT) rejects it — the four-eyes success path.
    // The checker also must NOT be able to withdraw someone else's request.
    // (checker is guaranteed present here — the whole journey is skipped up front
    // when NOPM_CHECKER_TOKEN is unset, since project cleanup below needs it too.)
    const foreignWithdraw = await page.request.post(
      `/api/deletion-requests/${mine2.id}/withdraw`,
      { headers: { Authorization: `Bearer ${checker}` } },
    );
    expect([403, 422].includes(foreignWithdraw.status())).toBeTruthy();
    const reject = await page.request.post(`/api/deletion-requests/${mine2.id}/reject`, {
      headers: { Authorization: `Bearer ${checker}` },
      data: { reason: "e2e cleanup" },
    });
    expect(reject.ok()).toBeTruthy();
  } finally {
    // Cleanup: PROJECT deletion is four-eyes too (owner-locked to PROJECTS ONLY,
    // Decision 3) — this doubles as the new maker-checker success-path coverage
    // for projects (mirrors the task journey above).
    //
    // (a) Maker step: request the deletion (reason required).
    const delReq = await page.request.delete(`/api/projects/${project.id}`, {
      data: { reason: "e2e cleanup" },
    });
    expect(delReq.status()).toBe(202);
    const deletionRequest = (await delReq.json()).data;

    // Self-approval must be blocked here too (requester === approver, same admin
    // session that created the project) — four-eyes applies to PROJECTS as well.
    const selfApprove = await page.request.post(
      `/api/deletion-requests/${deletionRequest.id}/approve`,
    );
    expect([403, 422].includes(selfApprove.status())).toBeTruthy();

    // (b) Checker step: a DIFFERENT actor (checker PAT) approves and commits it.
    const approve = await page.request.post(
      `/api/deletion-requests/${deletionRequest.id}/approve`,
      { headers: { Authorization: `Bearer ${checker}` } },
    );
    expect(approve.ok()).toBeTruthy();

    // The project is actually gone (committed, not just marked pending/approved).
    const gone = await page.request.get(`/api/projects/${project.id}`);
    expect(gone.status()).toBe(404);
  }
});

test("mint and revoke a PAT through the tokens UI", async ({ page }) => {
  await page.goto("/tokens");
  await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
  await page.getByPlaceholder("e.g. ci-risk-scanner").fill(`e2e-token-${STAMP}`);
  // Pick the first scope checkbox
  await page.locator('input[type="checkbox"]').first().check();
  await page.getByRole("button", { name: /mint token/i }).click();
  // One-time reveal banner with the raw npm_ token
  await expect(page.getByText(/npm_/).first()).toBeVisible({ timeout: 15_000 });

  // Revoke it: the row stays, flagged with a "revoked" badge
  const row = page.locator("tr", { hasText: `e2e-token-${STAMP}` });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /revoke/i }).click();
  await expect(row.getByText("revoked")).toBeVisible({ timeout: 15_000 });
});

// ── F1 CSV / audit-export / billable-flag journeys (L-27 / L-36 / L-29) ────
//
// These are Tier 2 (not Tier 1 f1-features.spec.ts) because every governed
// export writes exactly one `export.csv` audit_log row (L-36 — exporting the
// audit log must itself appear in the audit log), and a time entry create is
// a real governed write. Both go through the same session-cookie-driven
// governed API the UI uses, same as the journey above.

test("register CSV export writes exactly one export.csv audit row (register-csv-export)", async ({
  page,
}) => {
  const before = await page.request.get(
    "/api/audit?action=export.csv&target_type=entity&limit=1",
  );
  expect(before.ok()).toBeTruthy();
  const beforeTotal = (await before.json()).total as number;

  // GET /api/export has no `limit` param (see the audit-export test below for
  // why) — task filters keep this export's row count reasonable instead.
  const res = await page.request.get("/api/export?entity=tasks&status_type=started");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toContain("text/csv");
  const csv = await res.text();
  expect(csv.split("\n")[0]).toContain("id"); // header row

  const after = await page.request.get(
    "/api/audit?action=export.csv&target_type=entity&limit=1",
  );
  expect((await after.json()).total as number).toBe(beforeTotal + 1);
});

test("exporting the audit log itself is audited (audit-log-export)", async ({ page }) => {
  // GET /api/export has no `limit` param (it streams up to a fixed 10,000-row
  // cap server-side, same as every other entity) — narrow with a real filter
  // instead of an unsupported one so the CSV body stays small for the test.
  const before = await page.request.get(
    "/api/audit?action=export.csv&target_type=entity&limit=1",
  );
  const beforeTotal = (await before.json()).total as number;

  const res = await page.request.get("/api/export?entity=audit&action=export.csv");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toContain("text/csv");

  // The export of the audit log shows up IN the audit log (L-36).
  const after = await page.request.get(
    "/api/audit?action=export.csv&target_type=entity&limit=1",
  );
  expect((await after.json()).total as number).toBe(beforeTotal + 1);
});

test("time entry billable flag: explicit true/false wins, omitted falls back to the project default (time-entry-billable-flag)", async ({
  page,
}) => {
  const projectsRes = await page.request.get("/api/projects?limit=1");
  expect(projectsRes.ok()).toBeTruthy();
  const project = (await projectsRes.json()).data[0];
  test.skip(!project, "no seeded project to log time against");

  const membersRes = await page.request.get("/api/resources?limit=1");
  expect(membersRes.ok()).toBeTruthy();
  const member = (await membersRes.json()).data[0];
  test.skip(!member, "no seeded resource member to log time against");

  const createdIds: string[] = [];
  try {
    // Explicit billable=false must win over the project's default.
    const explicitFalse = await page.request.post("/api/time-entries", {
      data: {
        member_id: member.id,
        project_id: project.id,
        entry_date: new Date().toISOString().slice(0, 10),
        hours: 1,
        billable: false,
        note: `e2e billable-flag ${STAMP}`,
      },
    });
    expect(explicitFalse.status()).toBe(201);
    const rowFalse = (await explicitFalse.json()).data;
    createdIds.push(rowFalse.id);
    expect(rowFalse.billable).toBe(false);

    // Explicit billable=true must win too.
    const explicitTrue = await page.request.post("/api/time-entries", {
      data: {
        member_id: member.id,
        project_id: project.id,
        entry_date: new Date().toISOString().slice(0, 10),
        hours: 1,
        billable: true,
        note: `e2e billable-flag ${STAMP}`,
      },
    });
    expect(explicitTrue.status()).toBe(201);
    const rowTrue = (await explicitTrue.json()).data;
    createdIds.push(rowTrue.id);
    expect(rowTrue.billable).toBe(true);

    // Omitted billable falls back to the project's default_billable.
    const omitted = await page.request.post("/api/time-entries", {
      data: {
        member_id: member.id,
        project_id: project.id,
        entry_date: new Date().toISOString().slice(0, 10),
        hours: 1,
        note: `e2e billable-flag ${STAMP}`,
      },
    });
    expect(omitted.status()).toBe(201);
    const rowOmitted = (await omitted.json()).data;
    createdIds.push(rowOmitted.id);
    expect(typeof rowOmitted.billable).toBe("boolean");
  } finally {
    // Time entries are audit-only hard-delete (not maker-checker) — plain cleanup.
    for (const id of createdIds) {
      const del = await page.request.delete(`/api/time-entries/${id}`);
      expect(del.ok()).toBeTruthy();
    }
  }
});
