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
  // Pick the first VISIBLE scope checkbox (the phone layout keeps a hidden collapsed copy first in the DOM)
  await page.locator('input[type="checkbox"]:visible').first().check();
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

// ── F2a write journeys (programs / saved views / preferences) ──────────────
//
// Same idiom as the F1 block above: real governed writes over the same
// session-cookie-driven API the UI and agents use, each asserting the exact
// governance semantics the L-row's acceptance criteria demand, with full
// cleanup in a `finally`.

test("program CRUD via API writes exactly one audit row per mutation (program-crud)", async ({
  page,
}) => {
  // Environment-readiness guard (see f2a-features.spec.ts's program-rollup
  // test for the same check + the sprint receipt for why): migration
  // 20260815000034 not applied / schema cache not reloaded is an infra gap
  // this worker cannot fix (never runs migrations) — skip, don't fail.
  const probe = await page.request.get("/api/programs?limit=1");
  test.skip(
    !probe.ok(),
    "GET /api/programs failed — programs table not migrated / schema cache not reloaded in this environment",
  );

  const created = await page.request.post("/api/programs", {
    data: { code: `E2E${Date.now() % 100000}`, name: `E2E Program ${STAMP}` },
  });
  expect(created.status()).toBe(201);
  const program = (await created.json()).data;

  async function auditTotal(action: string) {
    const res = await page.request.get(
      `/api/audit?action=${action}&target_type=program&target_id=${program.id}&limit=1`,
    );
    expect(res.ok()).toBeTruthy();
    return (await res.json()).total as number;
  }

  try {
    expect(await auditTotal("program.create")).toBe(1);

    // L-02: rag_status is settable independently of the computed child rollup.
    const patched = await page.request.patch(`/api/programs/${program.id}`, {
      data: { rag_status: "amber" },
    });
    expect(patched.ok()).toBeTruthy();
    expect((await patched.json()).data.rag_status).toBe("amber");
    expect(await auditTotal("program.update")).toBe(1);
  } finally {
    // L-01: deleting a program is a plain audited hard delete — NOT
    // maker-checker (owner-locked, PROJECTS ONLY) — and must never cascade
    // into child projects (none attached here, so this only proves the
    // delete itself completes and is audited).
    const del = await page.request.delete(`/api/programs/${program.id}`);
    expect(del.status()).toBe(204);
    expect(await auditTotal("program.delete")).toBe(1);
    const gone = await page.request.get(`/api/programs/${program.id}`);
    expect(gone.status()).toBe(404);
  }
});

test("saved view four corners: create → share → protect → delete, each audited, personal views invisible to a second identity (saved-view-four-corners)", async ({
  page,
}) => {
  // Environment-readiness guard (migration 20260815000035 — see
  // program-crud's identical guard above for why this worker skips rather
  // than fixes it).
  const probe = await page.request.get("/api/saved-views?limit=1");
  test.skip(
    !probe.ok(),
    "GET /api/saved-views failed — saved_views table not migrated / schema cache not reloaded in this environment",
  );

  // A second identity to prove personal-invisibility (L-41's acceptance
  // criterion demands "verified by logging in as a second identity, not an
  // admin-based query"). NOPM_CHECKER_TOKEN (scripts/bootstrap.mjs) is the
  // pre-provisioned second actor the project/task four-eyes journey above
  // reuses, but its scope list (["project:read","task:read",
  // "task:delete:approve","project:delete:approve","rebaseline:approve",
  // "audit:read"]) carries no saved_view:* grant — extending shared demo
  // bootstrap infra is out of this task's scope, so a fresh, narrowly-scoped
  // PAT is minted here instead (same "mint and revoke a PAT" idiom as the
  // token test above). A token actor's `id` is the token row's own id
  // (lib/auth/guard.ts) — never the admin session's profile id — so this
  // genuinely is a different identity for isVisibleToActor's owner_id check.
  const mintRes = await page.request.post("/api/tokens", {
    data: {
      name: `e2e-second-identity-${STAMP}`,
      scopes: ["saved_view:read", "saved_view:write"],
    },
  });
  expect(mintRes.status()).toBe(201);
  const minted = (await mintRes.json()).data;
  const secondIdentity = minted.token as string;

  let viewId: string | undefined;
  try {
    async function auditTotal(action: string, targetId: string) {
      const res = await page.request.get(
        `/api/audit?action=${action}&target_type=saved_view&target_id=${targetId}&limit=1`,
      );
      expect(res.ok()).toBeTruthy();
      return (await res.json()).total as number;
    }

    // Create — personal by default, one saved_view.create audit row.
    const createRes = await page.request.post("/api/saved-views", {
      data: {
        register: "tasks",
        name: `E2E view ${STAMP}`,
        scope: "personal",
        config: { columns: ["name", "status_type"] },
      },
    });
    expect(createRes.status()).toBe(201);
    const view = (await createRes.json()).data;
    viewId = view.id;
    expect(view.scope).toBe("personal");
    expect(await auditTotal("saved_view.create", view.id)).toBe(1);

    // Personal-invisibility (L-41): the second identity's list must NOT
    // include it, and a direct GET degrades to 404 (not 403) — the
    // non-leaking shape saved-views/[id]/route.ts documents.
    const secondList = await page.request.get(
      `/api/saved-views?register=tasks&limit=100`,
      { headers: { Authorization: `Bearer ${secondIdentity}` } },
    );
    expect(secondList.ok()).toBeTruthy();
    expect(
      (await secondList.json()).data.some((v: { id: string }) => v.id === view.id),
    ).toBe(false);
    const secondGetBefore = await page.request.get(`/api/saved-views/${view.id}`, {
      headers: { Authorization: `Bearer ${secondIdentity}` },
    });
    expect(secondGetBefore.status()).toBe(404);

    // Share (L-06) — one saved_view.shared audit row; now visible to the
    // second identity.
    const sharedRes = await page.request.patch(`/api/saved-views/${view.id}`, {
      data: { scope: "shared" },
    });
    expect(sharedRes.ok()).toBeTruthy();
    expect((await sharedRes.json()).data.scope).toBe("shared");
    expect(await auditTotal("saved_view.shared", view.id)).toBe(1);
    const secondListAfterShare = await page.request.get(
      `/api/saved-views?register=tasks&limit=100`,
      { headers: { Authorization: `Bearer ${secondIdentity}` } },
    );
    expect(
      (await secondListAfterShare.json()).data.some((v: { id: string }) => v.id === view.id),
    ).toBe(true);

    // Protect (L-07) — one saved_view.protected audit row; a config PATCH is
    // now rejected 403 unless the same call also unprotects.
    const protectRes = await page.request.patch(`/api/saved-views/${view.id}`, {
      data: { protected: true },
    });
    expect(protectRes.ok()).toBeTruthy();
    expect((await protectRes.json()).data.protected).toBe(true);
    expect(await auditTotal("saved_view.protected", view.id)).toBe(1);

    const blockedConfigPatch = await page.request.patch(`/api/saved-views/${view.id}`, {
      data: { config: { columns: ["name"] } },
    });
    expect(blockedConfigPatch.status()).toBe(403);

    // Delete — one saved_view.delete audit row.
    const delRes = await page.request.delete(`/api/saved-views/${view.id}`);
    expect(delRes.status()).toBe(204);
    expect(await auditTotal("saved_view.delete", view.id)).toBe(1);
    viewId = undefined; // already cleaned up

    const gone = await page.request.get(`/api/saved-views/${view.id}`);
    expect(gone.status()).toBe(404);
  } finally {
    if (viewId) {
      await page.request.delete(`/api/saved-views/${viewId}`).catch(() => {});
    }
    await page.request.delete(`/api/tokens/${minted.id}`).catch(() => {});
  }
});

test("PUT /api/me/preferences round-trips density/dateDisplay/columns with zero audit rows (prefs-persistence)", async ({
  page,
}) => {
  const before = await page.request.get("/api/me/preferences");
  // Environment-readiness guard (migration 20260815000036 — see
  // program-crud's identical guard above for why this worker skips rather
  // than fixes it).
  test.skip(
    !before.ok(),
    "GET /api/me/preferences failed — user_preferences table not migrated / schema cache not reloaded in this environment",
  );
  const beforeJson = await before.json();
  expect(typeof beforeJson.data.demo).toBe("boolean");

  // ADR 0009 (amended for user_preferences): zero writeAudit calls anywhere
  // in this route, ever — there is no target_id to scope by (no `id` column
  // is ever returned), so the closest machine-checkable proxy is that this
  // action name never appears in the audit log at all, before or after.
  const auditBefore = await page.request.get(`/api/audit?action=user_preferences.update&limit=1`);
  const auditBeforeTotal = (await auditBefore.json()).total as number;
  expect(auditBeforeTotal).toBe(0);

  try {
    const put = await page.request.put("/api/me/preferences", {
      data: {
        config: {
          density: "compact",
          dateDisplay: "relative",
          columns: { tasks: ["name", "status_type"] },
        },
      },
    });
    expect(put.ok()).toBeTruthy();
    const putJson = await put.json();
    expect(putJson.data.config.density).toBe("compact");
    expect(putJson.data.config.dateDisplay).toBe("relative");
    expect(putJson.data.config.columns.tasks).toEqual(["name", "status_type"]);

    // Round trip: a fresh GET reflects exactly what was just written.
    const after = await page.request.get("/api/me/preferences");
    const afterJson = await after.json();
    expect(afterJson.data.config.density).toBe("compact");
    expect(afterJson.data.config.dateDisplay).toBe("relative");

    // Unknown keys are stripped, not rejected (L-39 acceptance criterion).
    const putWithJunk = await page.request.put("/api/me/preferences", {
      data: { config: { density: "comfortable", notARealKey: "nope" } },
    });
    expect(putWithJunk.ok()).toBeTruthy();
    expect((await putWithJunk.json()).data.config).not.toHaveProperty("notARealKey");

    const auditAfter = await page.request.get(`/api/audit?action=user_preferences.update&limit=1`);
    expect((await auditAfter.json()).total as number).toBe(0);
  } finally {
    // Reset to the pre-test config so this real per-account row doesn't leak
    // state into a later run (same "reset so the shared session doesn't
    // leak state" idiom f1-features.spec.ts's density-toggle test uses).
    // PUT is a merge-upsert (R-80): keys are never removed, so restoring the
    // pre-test config alone would leave the test's `columns.tasks` in place
    // and hide Priority for every later run on this identity. Put the
    // previous task columns back explicitly, or the register's defaults.
    const beforeConfig = beforeJson.data.config ?? {};
    const beforeTaskColumns: string[] | undefined = beforeConfig.columns?.tasks;
    const restoreTaskColumns =
      beforeTaskColumns && beforeTaskColumns.length > 0
        ? beforeTaskColumns
        : ["name", "status_type", "priority", "due_date", "completion_pct"];
    await page.request
      .put("/api/me/preferences", {
        data: { config: { ...beforeConfig, columns: { ...(beforeConfig.columns ?? {}), tasks: restoreTaskColumns } } },
      })
      .catch(() => {});
  }
});
