import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { ADMIN_STATE, SHELL_MARKER } from "./helpers";

// The richest page: /projects/[id] with its 8 tabs, gantt switcher and kanban board.
// Tabs are plain buttons; Risks/Issues carry a count badge in the accessible name
// ("Risks 3"), so tab locators anchor on the label with an optional trailing count.

test.use({ storageState: ADMIN_STATE });
test.skip(!existsSync(ADMIN_STATE), "admin storage state not minted (Supabase env missing)");

const TABS = ["Charter", "Overview", "Activity", "Board", "Gantt", "Risks", "Issues", "History"];

function tabButton(page: Page, label: string) {
  // Count badges concatenate into the accessible name with no separator ("Risks0")
  return page.getByRole("button", { name: new RegExp(`^${label}\\s?\\d*$`) }).first();
}

async function openFirstProject(page: Page) {
  await page.goto("/projects");
  await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
  await page.locator('a[href^="/projects/"]').first().click();
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]+/, { timeout: 15_000 });
}

test("project detail renders with all 8 tabs and Edit/Lock controls", async ({ page }) => {
  await openFirstProject(page);
  for (const tab of TABS) {
    await expect(tabButton(page, tab)).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /^edit$/i }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^(lock|unlock)$/i }).first()).toBeVisible();
});

test("every tab switches without an error boundary", async ({ page }) => {
  await openFirstProject(page);
  for (const tab of ["Overview", "Activity", "Board", "Gantt", "Risks", "Issues", "History", "Charter"]) {
    await tabButton(page, tab).click();
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  }
});

test("kanban board renders its five governed columns", async ({ page }) => {
  await openFirstProject(page);
  await tabButton(page, "Board").click();
  for (const col of ["Backlog", "To do", "In progress", "Done", "Canceled"]) {
    await expect(page.getByText(col, { exact: true }).first()).toBeVisible();
  }
});

test("gantt view switches day/week/month without crashing", async ({ page }) => {
  await openFirstProject(page);
  await tabButton(page, "Gantt").click();
  for (const view of [/^day$/i, /^week$/i, /^month$/i]) {
    const btn = page.getByRole("button", { name: view }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    }
  }
});

test("lock dialog opens and cancels without locking", async ({ page }) => {
  await openFirstProject(page);
  const lockBtn = page.getByRole("button", { name: /^lock$/i }).first();
  test.skip(!(await lockBtn.isVisible().catch(() => false)), "project already locked");
  await lockBtn.click();
  await expect(page.getByRole("button", { name: /lock baseline/i })).toBeVisible();
  await page.getByRole("button", { name: /^cancel$/i }).click();
  await expect(page.getByRole("button", { name: /lock baseline/i })).toBeHidden();
});
