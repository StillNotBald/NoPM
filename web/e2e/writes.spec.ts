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

test("full governed journey: create → render → task → status → maker-checker request → self-approve blocked → withdraw → re-request → reject → cleanup", async ({
  page,
}) => {
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
    const checker = checkerToken();
    if (checker) {
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
    }
    // (without a checker token, the pending request is cascaded by project cleanup)
  } finally {
    // Cleanup: hard-delete the project (cascades tasks; audited by design)
    const del = await page.request.delete(`/api/projects/${project.id}`);
    expect(del.ok()).toBeTruthy();
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
