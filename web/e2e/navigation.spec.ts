import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { ADMIN_STATE, SHELL_MARKER } from "./helpers";

// Global chrome: sidebar, command palette, account menu, notification bell, theme toggle.

test.use({ storageState: ADMIN_STATE });
test.skip(!existsSync(ADMIN_STATE), "admin storage state not minted (Supabase env missing)");

test.beforeEach(async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
});

test("sidebar navigates between console sections", async ({ page }) => {
  for (const [name, url] of [
    ["Projects", /\/projects/],
    ["Risks", /\/risks/],
    ["Trust Center", /\/trust/],
    ["Dashboard", /\/dashboard/],
  ] as const) {
    await page.getByRole("link", { name, exact: true }).first().click();
    await expect(page).toHaveURL(url);
  }
});

test("command palette opens with Ctrl+K, filters, and closes with Esc", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+KeyK");
  const search = page.getByPlaceholder(/search commands/i);
  await expect(search).toBeVisible();
  await search.fill("risks");
  await expect(page.getByText(/go to risks|risks/i).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
});

test("command palette navigates to a section", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+KeyK");
  const search = page.getByPlaceholder(/search commands/i);
  await expect(search).toBeVisible();
  await search.fill("tokens");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tokens/);
});

test("account menu opens and lists profile, settings and sign out", async ({ page }) => {
  await page.locator('button[aria-label="Account menu"]').click();
  await expect(page.getByRole("menuitem", { name: /settings/i }).or(page.getByText("Settings").first())).toBeVisible();
  await expect(page.getByText(/sign out/i).first()).toBeVisible();
  await page.keyboard.press("Escape");
});

test("notification bell opens the notification tray", async ({ page }) => {
  await page.locator('button[aria-label*="Notifications"]').click();
  // Tray shows either items or an empty state; both prove the tray opened
  await expect(
    page.getByRole("button", { name: /mark all read/i }).or(page.getByText(/no notifications|all caught up/i).first()),
  ).toBeVisible();
});

test("theme toggle switches theme", async ({ page }) => {
  const before = await page.evaluate(() => document.documentElement.className + document.documentElement.getAttribute("data-theme"));
  await page.locator('button[aria-label*="theme" i], button[aria-label*="Theme" i]').first().click();
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.className + document.documentElement.getAttribute("data-theme")),
    )
    .not.toBe(before);
});

test("AI assistant panel opens and closes", async ({ page }) => {
  await page.locator('button[aria-label="Open AI assistant"]').click();
  // Panel stays mounted and slides off-screen; aria-hidden is the open signal
  const panel = page.locator('[role="dialog"][aria-label="AI Assistant"]');
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  await panel.locator('button[aria-label="Close assistant panel"]').click();
  await expect(panel).toHaveAttribute("aria-hidden", "true");
});
