import { test, expect } from "@playwright/test";

// The demo login is the public funnel's wow-moment entry: a zero-JS POST form.
// (Lesson learned previously: verify AS the entry-path identity, not just as admin.)

test.describe("demo login funnel", () => {
  test("clicking the demo button lands on an authenticated dashboard", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /try the live demo/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    // Real console chrome rendered (not an error boundary)
    await expect(page.locator('button[aria-label="Account menu"]')).toBeVisible();
  });

  test("demo identity can browse the governed registers", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /try the live demo/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    for (const path of ["/projects", "/risks", "/trust"]) {
      await page.goto(path);
      await expect(page.locator('button[aria-label="Account menu"]')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(path.replace("/", "\\/")));
    }
  });

  test("demo user can sign out again", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /try the live demo/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    await page.locator('button[aria-label="Account menu"]').click();
    await page.getByText(/^sign out$/i).click();
    await expect(page).toHaveURL(/\/(login|\?|$)/, { timeout: 15_000 });
    // Session really gone: console pages bounce back to /login
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});
