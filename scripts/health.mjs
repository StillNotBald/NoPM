#!/usr/bin/env node
// health.mjs — one-command RAG read on the state of the project.
// No network, no test run: reads the requirements register, the RTM, the
// generated metrics, the sprint log, and the ADR index. For the full gates,
// run the pre-push hook or CI.
//
// Usage: npm run health   (from the repo root)
import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

const GREEN = "\x1b[32m●\x1b[0m", AMBER = "\x1b[33m●\x1b[0m", RED = "\x1b[31m●\x1b[0m";
const row = (light, label, detail) => console.log(`  ${light}  ${label.padEnd(22)} ${detail}`);

console.log("\nNoPM health\n");

// ── Requirements ─────────────────────────────────────────────────────────────
const req = read("requirements", "REQUIREMENTS.md");
const statuses = { DONE: 0, PARTIAL: 0, TODO: 0 };
for (const m of req.matchAll(/^- \*\*R-\d+\*\*[^\n]*\*\*(DONE|PARTIAL|TODO)\*\*/gm)) statuses[m[1]]++;
const rids = new Set(req.match(/^- \*\*(R-\d+)\*\*/gm) ?? []).size;
row(
  statuses.TODO > 2 ? AMBER : GREEN,
  "Requirements",
  `${rids} R-IDs — ${statuses.DONE} done, ${statuses.PARTIAL} partial, ${statuses.TODO} todo`,
);

// ── RTM ──────────────────────────────────────────────────────────────────────
let rtmLight = RED, rtmDetail = "rtm-verify failed";
try {
  const out = execSync("node scripts/rtm-verify.mjs", { cwd: ROOT, encoding: "utf8" });
  rtmDetail = out.trim().split("\n").pop();
  rtmLight = GREEN;
} catch (e) {
  rtmDetail = String(e.stdout || e.message).trim().split("\n").pop();
}
row(rtmLight, "RTM integrity", rtmDetail);

// ── Test evidence (from the generated metrics; CI verifies freshness) ────────
try {
  const metrics = JSON.parse(read("web", "src", "lib", "metrics.gen.json"));
  row(GREEN, "Test evidence", `${metrics.tests} vitest tests · ${metrics.endpoints} documented endpoints (metrics.gen.json, CI-checked)`);
} catch {
  row(RED, "Test evidence", "metrics.gen.json missing — run: cd web && node scripts/gen-metrics.mjs");
}

// ── Sprint log freshness ─────────────────────────────────────────────────────
const sprints = readdirSync(path.join(ROOT, "sprint-log"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(d.name))
  .map((d) => d.name)
  .sort();
const latest = sprints[sprints.length - 1] ?? "(none)";
const latestDate = new Date(latest.slice(0, 10));
const ageDays = Math.floor((Date.now() - latestDate.getTime()) / 86_400_000);
row(
  ageDays > 60 ? AMBER : GREEN,
  "Sprint log",
  `${sprints.length} receipts — latest ${latest} (${ageDays}d ago)`,
);

// ── ADRs ─────────────────────────────────────────────────────────────────────
const adrs = readdirSync(path.join(ROOT, "docs", "adr")).filter((f) => /^\d{4}-.*\.md$/.test(f));
row(GREEN, "ADRs", `${adrs.length} decision records`);

// ── Leak gate ────────────────────────────────────────────────────────────────
let gateLight = GREEN, gateDetail = "hashed blocklist clean over tracked files";
try {
  execSync("node scripts/commit-gate.mjs --all", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  gateLight = RED;
  const lines = String(e.stdout ?? "").trim().split("\n");
  gateDetail = `${lines.filter((l) => l.startsWith("✗")).length} blocked file(s) — run: node scripts/commit-gate.mjs --all`;
}
row(gateLight, "Leak gate", gateDetail);

console.log("\n  Full gates (typecheck + tests + RTM + metrics + CLI): .githooks/pre-push or CI.\n");
