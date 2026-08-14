import { test, expect } from "@playwright/test";

// Public, unauthenticated surfaces: landing, login, case study.

test.describe("landing page", () => {
  test("renders hero with demo entry and sign-in link", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /try the live demo/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /sign in/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /case study/i }).first()).toBeVisible();
  });

  test("sign-in link navigates to /login", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /sign in/i }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("login page", () => {
  test("renders demo card, email/password form and submit button", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to your workspace" })).toBeVisible();
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("button", { name: /try the live demo/i })).toBeVisible();
  });

  test("wrong credentials show an inline error, not a crash", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill("nobody@example.com");
    await page.locator("#password").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    // Supabase returns "Invalid login credentials"; assert an error surface appears
    await expect(page.locator("p.text-danger, [class*='text-danger']").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL(/\/login/);
  });

  test("console pages redirect unauthenticated visitors to /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("case study page", () => {
  test("renders with demo buttons and one-pager download button", async ({ page }) => {
    await page.goto("/case-study");
    await expect(page.getByRole("button", { name: /demo/i }).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /download case study as a one-page pdf/i }).first(),
    ).toBeVisible();
  });
});

test.describe("machine-readable surfaces", () => {
  test("GET /api/health returns ok", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
  });

  test("GET /api/openapi.json serves the spec", async ({ request }) => {
    const res = await request.get("/api/openapi.json");
    expect(res.status()).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths).length).toBeGreaterThan(30);
  });

  test("GET /llms.txt serves agent docs", async ({ request }) => {
    const res = await request.get("/llms.txt");
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("NoPM");
  });
});
