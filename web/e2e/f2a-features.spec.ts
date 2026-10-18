import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { ADMIN_STATE, SHELL_MARKER } from "./helpers";

// Tier 1 — read-only journeys for the F2a "lite feature track" wave (R-71
// programs, R-72 saved views + view config + Mainline lens switcher). Same
// idiom as f1-features.spec.ts: admin storageState, SHELL_MARKER for "real
// console chrome rendered", skip (not fail) when Supabase env wasn't
// available to mint the admin session, and a precondition-driven
// `test.skip` rather than a fabricated fixture wherever a journey depends
// on seeded/backfilled data this spec cannot create itself (Tier 1 is
// read-only by design — Tier 2 in writes.spec.ts owns every write).

test.describe("admin-authenticated journeys", () => {
  test.use({ storageState: ADMIN_STATE });
  test.skip(!existsSync(ADMIN_STATE), "admin storage state not minted (Supabase env missing)");

  // ── programs on the Portfolio roadmap (L-01/L-02/L-03) ────────────────────

  test.describe("portfolio program rollup (L-01/L-02/L-03)", () => {
    test(
      "portfolio renders at least one program rollup card, with declared + computed RAG (program-rollup)",
      async ({ page }) => {
        // migration 20260815000034's backfill turns every existing legacy
        // projects.program text label into a real `programs` row — but this
        // worker never runs migrations (house rule), so degrade gracefully
        // (skip, not fail) if this environment hasn't had it applied /
        // schema-cache-reloaded yet (observed against the live dev env at
        // task time: GET /api/programs 500s PGRST205 "table not found in
        // the schema cache" — see the sprint receipt).
        const programsRes = await page.request.get("/api/programs?limit=1");
        test.skip(
          !programsRes.ok(),
          "GET /api/programs failed — programs table not migrated / schema cache not reloaded in this environment",
        );
        const total = (await programsRes.json()).total as number;
        test.skip(total === 0, "no programs seeded/backfilled in this environment");

        await page.goto("/portfolio");
        await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
        // ProgramRollupCard's fixed header labels — present once per program.
        await expect(page.getByText("Declared", { exact: true }).first()).toBeVisible();
        await expect(page.getByText("Computed", { exact: true }).first()).toBeVisible();
        // Rollup grid ("Completion" stat, or the empty-state copy for a
        // program with zero projects — either is a correctly-rendered card).
        await expect(
          page
            .getByText("Completion", { exact: true })
            .first()
            .or(page.getByText("No projects in this program yet.").first()),
        ).toBeVisible();
      },
    );
  });

  // ── /tasks Save-view button + views dropdown (L-05/06/07/41 — read half) ──

  test.describe("saved views on /tasks (L-05/06/07/41)", () => {
    test(
      "/tasks shows a Save view button and a Views dropdown (saved-view-apply, read-only half)",
      async ({ page }) => {
        await page.goto("/tasks");
        await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });

        // "Save view" opens the save form — inspect it, then cancel without
        // saving (actually creating a view is Tier 2, writes.spec.ts).
        await page.getByRole("button", { name: /^save view$/i }).click();
        await expect(
          page.getByText("Save current filters + sort + columns + grouping"),
        ).toBeVisible();
        await page.getByRole("button", { name: /^cancel$/i }).click();

        // "Views" opens the views dropdown — either the empty-state copy or
        // a Personal/Shared section, never a blank/erroring popover.
        await page.getByRole("button", { name: /^views$/i }).click();
        await expect(
          page
            .getByText("No saved views for this register yet.", { exact: true })
            .or(page.getByText("Personal", { exact: true }))
            .or(page.getByText("Shared", { exact: true }))
            .first(),
        ).toBeVisible();
      },
    );
  });

  // ── group-by / column chooser / aggregate footer (L-09/L-11/L-16) ─────────

  test.describe("/tasks register controls (L-09/L-11/L-16)", () => {
    test(
      "group-by selector groups rows under headers with counts (register-group-by)",
      async ({ page }) => {
        const tasksRes = await page.request.get("/api/tasks?limit=1");
        expect(tasksRes.ok()).toBeTruthy();
        test.skip(((await tasksRes.json()).total as number) === 0, "no seeded tasks to group");

        await page.goto("/tasks");
        await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });

        // Uniquely identified among the page's <select>s: the group-by
        // select is the only one whose option list includes "Status" as
        // LITERAL text (FilterBar's own status_type <select> options are the
        // enum values — Backlog/Unstarted/Started/Completed/Canceled — none
        // of which contain the substring "Status").
        await page.waitForLoadState("networkidle"); // hydrate before driving the select (dev server)
        const groupBySelect = page.locator("select").filter({ hasText: "Status" });
        await expect(groupBySelect).toBeVisible();
        await groupBySelect.selectOption("status_type");

        // Group header row: "{label} · {count}" (group-by-select.tsx / tasks
        // page's GroupRows renderer).
        await expect(page.locator("tr", { hasText: /·\s*\d+/ }).first()).toBeVisible();
      },
    );

    test("column chooser hides a visible column (column-chooser)", async ({ page }) => {
      const tasksRes = await page.request.get("/api/tasks?limit=1");
      expect(tasksRes.ok()).toBeTruthy();
      test.skip(((await tasksRes.json()).total as number) === 0, "no seeded tasks to render a table");

      await page.goto("/tasks");
      await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });

      // Start from a known state: the choice persists per account, so an earlier
      // (failed) run may have left Priority hidden. Re-check it first.
      await page.getByRole("button", { name: /^columns$/i }).click();
      await page.getByRole("checkbox", { name: "Priority", exact: true }).check();

      // "Priority" is one of the DEFAULT_COLUMNS — visible in the table
      // header before any change.
      await expect(page.getByRole("columnheader", { name: /priority/i }).first()).toBeVisible();
      try {
        await page.getByRole("checkbox", { name: "Priority", exact: true }).uncheck();

        await expect(page.getByRole("columnheader", { name: /priority/i })).toHaveCount(0);
      } finally {
        // The chooser persists to the account's user_preferences row
        // (merge-upsert, keys are never removed) — re-check so the shared
        // admin identity does not leak a hidden column into later runs.
        await page.getByRole("checkbox", { name: "Priority", exact: true }).check().catch(() => {});
        await expect(page.getByRole("columnheader", { name: /priority/i }).first())
          .toBeVisible()
          .catch(() => {});
      }
    });

    test("aggregate footer renders a row count for the current page (view-aggregate-row)", async ({
      page,
    }) => {
      const tasksRes = await page.request.get("/api/tasks?limit=1");
      expect(tasksRes.ok()).toBeTruthy();
      test.skip(((await tasksRes.json()).total as number) === 0, "no seeded tasks to render a footer over");

      await page.goto("/tasks");
      await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
      // AggregateFooter's fixed "N row(s) (current page)" label — deliberately
      // scoped to "the current page", never a whole-register claim.
      await expect(page.getByText(/current page/i).first()).toBeVisible();
      await expect(page.getByText(/^\d+ rows?\b/).first()).toBeVisible();
    });
  });

  // ── Mainline 3-lens switcher (L-12 / R-28) ─────────────────────────────────

  test.describe("Mainline lens switcher (L-12)", () => {
    test(
      "/mainline renders and the lens switcher swaps lenses, updating the URL (mainline-lens-switcher)",
      async ({ page }) => {
        const projectsRes = await page.request.get("/api/projects?limit=1");
        expect(projectsRes.ok()).toBeTruthy();
        test.skip(
          ((await projectsRes.json()).total as number) === 0,
          "no seeded projects — Mainline renders its empty state",
        );

        await page.goto("/mainline");
        await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });

        const tablist = page.getByRole("tablist", { name: /mainline lens/i });
        await expect(tablist).toBeVisible();
        const subway = tablist.getByRole("tab", { name: /subway/i });
        const journal = tablist.getByRole("tab", { name: /journal/i });
        const network = tablist.getByRole("tab", { name: /network/i });
        await expect(subway).toHaveAttribute("aria-selected", "true");

        await journal.click();
        await expect(page).toHaveURL(/[?&]lens=project/);
        await expect(journal).toHaveAttribute("aria-selected", "true");

        await network.click();
        await expect(page).toHaveURL(/[?&]lens=dependency/);
        await expect(network).toHaveAttribute("aria-selected", "true");

        await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
      },
    );
  });

  // ── appearance persistence smoke (L-37/38/39/42 — cookie path only) ───────
  //
  // The DB round-trip (GET/PUT /api/me/preferences) is a real governed write
  // path and belongs in Tier 2 (writes.spec.ts, prefs-persistence). This is
  // just the "nothing regressed" smoke: the Appearance card (already fully
  // covered by f1-features.spec.ts's own describe block) still renders
  // cleanly now that AppearanceSection also fetches the DB merge in the
  // background (L-39 follow-through, settings/page.tsx).
  test.describe("appearance settings smoke (cookie path, L-37/38/39/42)", () => {
    test("settings page still renders the Appearance card with no errors (appearance-settings smoke)", async ({
      page,
    }) => {
      await page.goto("/settings");
      await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("heading", { name: /^appearance$/i })).toBeVisible();
      await expect(page.getByText(/display-only, never audited/i)).toBeVisible();
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    });
  });
}); // end "admin-authenticated journeys"
