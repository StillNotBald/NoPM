#!/usr/bin/env node
// setup-hooks.mjs — point git at the checked-in .githooks/ directory.
// Runs from the `prepare` script of both root and web package.json, so any
// clone that runs npm install gets the governance gates automatically.
// Silently no-ops outside a git checkout (e.g. npm-published tarballs, CI
// shallow environments without git).
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  execSync("git rev-parse --git-dir", { cwd: repoRoot, stdio: "ignore" });
  execSync("git config core.hooksPath .githooks", { cwd: repoRoot, stdio: "ignore" });
  console.log("✓ git hooks: core.hooksPath → .githooks (commit-gate + pre-push verify)");
} catch {
  // not a git checkout — nothing to install
}
