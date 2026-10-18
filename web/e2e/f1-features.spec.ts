import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { ADMIN_STATE, SHELL_MARKER } from "./helpers";

// Tier 1 — read-only journeys for the F1 "lite feature track" (R-68/R-69/R-70).
// Same idiom as console-pages.spec.ts / project-detail.spec.ts: admin
// storageState, SHELL_MARKER for "real console chrome rendered", skip
// (not fail) when Supabase env wasn't available to mint the admin session.
//
// Everything except the demo-identity describe at the bottom needs the admin
// fixture, so it's wrapped in its own describe rather than gated at file
// scope — the demo-identity journey logs in live (same as demo-login.spec.ts)
// and must NOT be skipped just because the admin.json fixture is missing.

test.describe("admin-authenticated journeys", () => {
  test.use({ storageState: ADMIN_STATE });
  test.skip(!existsSync(ADMIN_STATE), "admin storage state not minted (Supabase env missing)");

// ── cross-project task list (L-04 / L-08 / L-10) ────────────────────────────
//
// The /tasks page shipped at F1 land (main session, 2026-08-15) — these three
// journeys are ACTIVE and assert the target contract end to end.
test.describe("cross-project task list (L-04/L-08/L-10)", () => {
  test(
    "/tasks renders with filter bar + sort headers + export button (cross-project-task-list)",
    async ({ page }) => {
      await page.goto("/tasks");
      await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("combobox").first()).toBeVisible(); // filter bar
      await expect(page.getByRole("columnheader")).not.toHaveCount(0); // sort headers
      await expect(page.getByRole("link", { name: /export/i })).toBeVisible(); // export button
    },
  );

  test(
    "changing a filter updates the URL-encoded query string (register-filter-builder)",
    async ({ page }) => {
      await page.goto("/tasks");
      await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
      // Wait for hydration (dev server) before driving the select, else the change handler is not attached yet.
      await page.waitForLoadState("networkidle");
      await page.getByRole("combobox", { name: "Status" }).selectOption({ index: 1 });
      await expect(page).toHaveURL(/[?&](project_id|status_type|priority)=/, { timeout: 15_000 });
    },
  );

  test("clicking a sort header updates ?sort= (register-sort)", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /sort by due/i }).click();
    await expect(page).toHaveURL(/[?&]sort=due_date/);
  });

  // The backend half of the same journey IS live — assert the governed
  // contract directly (read-only, no audit row, safe for Tier 1).
  test("GET /api/tasks honors filter + sort params and returns the governed envelope", async ({
    page,
  }) => {
    const res = await page.request.get(
      "/api/tasks?status_type=started&sort=due_date:asc&limit=5",
    );
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(Array.isArray(json.data)).toBeTruthy();
    expect(typeof json.total).toBe("number");
  });

  test("GET /api/tasks rejects an unknown sort field with 422", async ({ page }) => {
    const res = await page.request.get("/api/tasks?sort=not_a_real_field:asc");
    expect(res.status()).toBe(422);
  });
});

// ── dashboard filter + freshness (L-15 / L-34) ──────────────────────────────

test.describe("dashboard filter + freshness (L-15/L-34)", () => {
  test("dashboard renders its filter bar and freshness stamp (dashboard-filter, dashboard-freshness)", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
    // Program + Project selects (dashboard-filter-bar.tsx field order) — the
    // project table also has "Program"/"Target" column headers, so scope to
    // the two <select> filter fields directly rather than matching by label
    // text (which would hit the table header too).
    await expect(page.locator("select").nth(0)).toBeVisible();
    await expect(page.locator("select").nth(1)).toBeVisible();
    // Freshness stamp — "Updated HH:MM:SS" + manual refresh button
    await expect(page.getByText(/^Updated \d{1,2}:\d{2}:\d{2}/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /refresh data/i }).first()).toBeVisible();
  });

  test("picking a project filter updates the URL-encoded query string", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
    const projectSelect = page.locator("select").nth(1); // Program is select 0, Project is select 1
    const optionCount = await projectSelect.locator("option").count();
    test.skip(optionCount < 2, "no seeded projects to filter by");
    await projectSelect.selectOption({ index: 1 });
    await expect(page).toHaveURL(/[?&]project=/);
    // Clear filters resets the URL
    await page.getByRole("button", { name: /clear filters/i }).click();
    await expect(page).not.toHaveURL(/[?&]project=/);
  });
});

// ── resources workload chart (L-13) ─────────────────────────────────────────

test.describe("resources workload chart (L-13)", () => {
  test("workload chart renders with a week/month period selector (workload-chart)", async ({
    page,
  }) => {
    await page.goto("/resources");
    await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /^workload$/i })).toBeVisible();
    const weekBtn = page.getByRole("button", { name: /^week$/i });
    const monthBtn = page.getByRole("button", { name: /^month$/i });
    await expect(weekBtn).toBeVisible();
    await expect(monthBtn).toBeVisible();
    await expect(weekBtn).toHaveAttribute("aria-pressed", "true");
    await monthBtn.click();
    await expect(monthBtn).toHaveAttribute("aria-pressed", "true");
    await expect(weekBtn).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  });
});

// ── settings Appearance card (L-37/L-38/L-42) ───────────────────────────────

test.describe("settings Appearance card (L-37/L-38/L-42)", () => {
  test("Appearance card renders all four controls (appearance-settings)", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /^appearance$/i })).toBeVisible();
    for (const label of ["Theme", "Text size", "Density", "Dates"]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test("toggling density flips the <html> class (density-toggle)", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
    const html = page.locator("html");
    // Start from a known state (Comfortable) then flip to Compact.
    await page.getByRole("button", { name: /^comfortable$/i }).click();
    await expect(html).not.toHaveClass(/density-compact/);
    await page.getByRole("button", { name: /^compact$/i }).click();
    await expect(html).toHaveClass(/density-compact/);
    // Reset so the shared session doesn't leak state into later specs.
    await page.getByRole("button", { name: /^comfortable$/i }).click();
    await expect(html).not.toHaveClass(/density-compact/);
  });

  test("toggling date display writes the cookie without an audit row (date-display-toggle)", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /^relative$/i }).click();
    const cookie = await page.evaluate(() => document.cookie);
    expect(cookie).toContain("nopm_appearance=");
    expect(decodeURIComponent(cookie)).toContain('"dateDisplay":"relative"');
    // Reset to the default so the shared session/other specs see Absolute dates.
    await page.getByRole("button", { name: /^absolute$/i }).click();
  });
});

// ── tokens: Connect your agent (L-49) ───────────────────────────────────────

test.describe("tokens: Connect your agent (L-49)", () => {
  test("Connect your agent card shows all three paths (connect-your-agent) — does NOT mint", async ({
    page,
  }) => {
    await page.goto("/tokens");
    await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /connect your agent/i })).toBeVisible();
    const tablist = page.getByRole("tablist", { name: /connect your agent/i });
    await expect(tablist).toBeVisible();
    for (const label of ["Mint scoped PAT", "MCP config", "BYOK assistant"]) {
      await expect(tablist.getByText(label, { exact: true })).toBeVisible();
    }
    // Explicitly do NOT click "Mint token" — this journey is read-only.
  });
});

}); // end "admin-authenticated journeys"

// ── role-aware empty states (L-46) — DEMO (viewer) identity ────────────────
//
// e2e/global-setup.mjs mints only an admin.json storage state — there is no
// pre-minted "demo" fixture to `test.use({ storageState: ... })` with. Per
// demo-login.spec.ts, the demo identity is exercised live: POST the public
// "Try the live demo" button, then browse as that (viewer-role) session for
// the remainder of the test. /tokens is a deterministic fit for this journey
// — the role gate (not the data being literally empty) decides which branch
// renders, so it doesn't depend on the shared demo workspace's token list
// being empty.
test.describe("role-aware empty states (L-46) — demo identity", () => {
  // No storageState here (unlike the admin describe above) — same as
  // demo-login.spec.ts, this project's default context starts signed out.

  test("demo identity (manager by design) gets the full tokens surface with no raw errors (role-aware-empty-states)", async ({
    page,
  }) => {
    // The shared demo login is deliberately a MANAGER (demo writes must work —
    // the old viewer demo 403'd every wow-moment; see the funnel-identity
    // lesson), so /tokens legitimately shows it the manage UI. The viewer
    // branch of the role gate (the 'restricted to admins and managers' empty
    // state) is covered at the component/unit level; exercising it end-to-end
    // needs a seeded viewer login — tracked for F2.
    await page.goto("/login");
    await page.getByRole("button", { name: /try the live demo/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

    await page.goto("/tokens");
    await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /existing tokens/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  });
});
