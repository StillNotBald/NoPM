import { test as base } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";

export const ADMIN_STATE = path.join(__dirname, ".auth", "admin.json");

/** Test base that runs with the minted admin session, or skips if setup couldn't mint one. */
export const adminTest = base.extend({});
adminTest.use({ storageState: ADMIN_STATE });

export function requireAdminState() {
  base.skip(!existsSync(ADMIN_STATE), "admin storage state not minted (Supabase env missing)");
}

/** Marker that a console page rendered its shell rather than an error boundary / login redirect. */
export const SHELL_MARKER = 'button[aria-label="Account menu"]';
