import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { ADMIN_STATE, SHELL_MARKER } from "./helpers";

// Every console page renders for a real admin session, with its primary action visible.
// This is the browser-level descendant of scripts/auth-smoke.mjs (which only checks HTTP 200).

test.use({ storageState: ADMIN_STATE });
test.skip(!existsSync(ADMIN_STATE), "admin storage state not minted (Supabase env missing)");

// route → [expected marker text/role assertions]
const PAGES: Array<{ path: string; probe: (page: import("@playwright/test").Page) => Promise<void> }> = [
  {
    path: "/dashboard",
    probe: async (page) => {
      await expect(page.getByRole("button", { name: /export board pack/i })).toBeVisible();
    },
  },
  {
    path: "/start",
    probe: async (page) => {
      await expect(page.getByRole("heading", { name: /getting started/i })).toBeVisible();
    },
  },
  { path: "/my-work", probe: async () => {} },
  {
    path: "/my-tasks",
    probe: async (page) => {
      // Filter pills carry a count in their accessible name ("All 12")
      await expect(page.getByRole("button", { name: /^all/i }).first()).toBeVisible();
    },
  },
  {
    path: "/projects",
    probe: async (page) => {
      await expect(page.getByRole("button", { name: /new project/i })).toBeVisible();
    },
  },
  { path: "/portfolio", probe: async () => {} },
  {
    path: "/documents",
    probe: async (page) => {
      await expect(page.getByRole("button", { name: /new document/i })).toBeVisible();
    },
  },
  {
    path: "/change-control",
    probe: async (page) => {
      await expect(page.getByRole("button", { name: /raise change request/i })).toBeVisible();
    },
  },
  {
    path: "/decisions",
    probe: async (page) => {
      await expect(page.getByRole("button", { name: /add decision/i })).toBeVisible();
    },
  },
  {
    path: "/risks",
    probe: async (page) => {
      await expect(page.getByRole("button", { name: /new risk/i })).toBeVisible();
    },
  },
  {
    path: "/issues",
    probe: async (page) => {
      await expect(page.getByRole("button", { name: /new issue/i })).toBeVisible();
    },
  },
  { path: "/clashes", probe: async () => {} },
  { path: "/budget", probe: async () => {} },
  {
    path: "/resources",
    probe: async (page) => {
      await expect(page.getByRole("button", { name: /add member/i }).first()).toBeVisible();
    },
  },
  { path: "/review", probe: async () => {} },
  { path: "/approvals", probe: async () => {} },
  { path: "/trust", probe: async () => {} },
  { path: "/email-previews", probe: async () => {} },
  {
    path: "/tokens",
    probe: async (page) => {
      await expect(page.getByRole("button", { name: /mint token/i })).toBeVisible();
    },
  },
  {
    path: "/settings",
    probe: async (page) => {
      await expect(page.getByRole("button", { name: /save changes/i })).toBeVisible();
    },
  },
];

for (const { path, probe } of PAGES) {
  test(`${path} renders with console chrome and primary actions`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(path.replace(/\//g, "\\/")));
    await expect(page.locator(SHELL_MARKER)).toBeVisible({ timeout: 20_000 });
    // No Next.js error boundary
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    await probe(page);
  });
}
