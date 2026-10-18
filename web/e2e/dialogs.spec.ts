import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { ADMIN_STATE, SHELL_MARKER } from "./helpers";

// Every "New X" entry button opens its form in the right push-panel (inspector)
// and can be dismissed without writing anything. The inspector always renders a
// `Close panel` button, so that is the universal open/close signal.

test.use({ storageState: ADMIN_STATE });
test.skip(!existsSync(ADMIN_STATE), "admin storage state not minted (Supabase env missing)");

const CLOSE_PANEL = 'button[aria-label="Close panel"]';

async function openAndCancel(page: Page, path: string, buttonName: RegExp, panelTitle: string) {
  await page.goto(path);
  await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: buttonName }).first().click();
  // The push panel stays mounted and slides off-screen; aria-hidden is the
  // canonical open/closed signal.
  // An "open" panel is one whose dialog is mounted with aria-hidden="false";
  // closing either unmounts it or flips the attribute — both drive count to 0.
  const openPanel = page.locator(
    `[role="dialog"][aria-label="${panelTitle}"][aria-hidden="false"]`,
  );
  await expect(openPanel).toHaveCount(1);
  await openPanel.locator(CLOSE_PANEL).click();
  await expect(openPanel).toHaveCount(0);
}

test("New Project form opens and cancels cleanly", async ({ page }) => {
  await openAndCancel(page, "/projects", /new project/i, "New Project");
});

test("New Risk form opens and cancels cleanly", async ({ page }) => {
  await openAndCancel(page, "/risks", /new risk/i, "New Risk");
});

test("New Issue form opens and cancels cleanly", async ({ page }) => {
  await openAndCancel(page, "/issues", /new issue/i, "New Issue");
});

test("Add Decision form opens and cancels cleanly", async ({ page }) => {
  await openAndCancel(page, "/decisions", /add decision/i, "Add Decision");
});

test("Raise Change Request form opens and cancels cleanly", async ({ page }) => {
  await openAndCancel(page, "/change-control", /raise change request/i, "Raise Change Request");
});

test("New Document form opens and cancels cleanly", async ({ page }) => {
  await openAndCancel(page, "/documents", /new document/i, "New Document");
});

test("Add Team Member form opens and cancels cleanly", async ({ page }) => {
  await openAndCancel(page, "/resources", /add member/i, "Add Team Member");
});

test("Export board pack menu opens and lists all three formats", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
  await page.locator('button[aria-label="Choose export format"]').click();
  await expect(page.getByText(/powerpoint/i)).toBeVisible();
  await expect(page.getByText(/html report/i)).toBeVisible();
  await expect(page.getByText(/pdf/i).first()).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Mint-token form is present with scope checkboxes but is not submitted", async ({ page }) => {
  await page.goto("/tokens");
  await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /mint token/i })).toBeVisible();
  // The phone layout (<md) renders a second, collapsed copy of the scope list in <details>; target the visible one.
  await expect(page.locator('input[type="checkbox"]:visible').first()).toBeVisible();
});
