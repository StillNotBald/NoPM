import { defineConfig, devices } from "@playwright/test";

// E2E suite. Two tiers:
//   Tier 1 (default)          — read-only: page renders, navigation, dialogs open/close.
//   Tier 2 (E2E_WRITES=1)     — write journeys (create/edit/maker-checker) with cleanup.
// Target: BASE env (defaults to local dev server, which Playwright starts itself).
const BASE = process.env.BASE || "http://localhost:3000";
const isLocal = !process.env.BASE;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  globalSetup: "./e2e/global-setup.mjs",
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(isLocal
    ? {
        webServer: {
          command: "npm run dev",
          url: "http://localhost:3000",
          reuseExistingServer: true,
          timeout: 180_000,
        },
      }
    : {}),
});
