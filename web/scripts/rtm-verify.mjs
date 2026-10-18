#!/usr/bin/env node
/**
 * rtm-verify.mjs — RTM consistency checker
 *
 * Reads requirements/REQUIREMENTS.md and requirements/TRACEABILITY.md,
 * checks that every R-ID present in REQUIREMENTS is also present in TRACEABILITY
 * with the same status, and asserts that every Code file path listed in the
 * Traceability table actually exists on disk.
 *
 * Exit 0 = all checks pass.
 * Exit 1 = one or more failures (prints each one).
 *
 * Usage (from repo root):  node web/scripts/rtm-verify.mjs
 *                          npm run rtm:verify   (from web/)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo root is two levels up from web/scripts/
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract R-ID rows from REQUIREMENTS.md.
 *  Returns Map<rid, status>
 */
function parseRequirements(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    // Match lines like:  - **R-01** Some title — **DONE** (...)
    // Use greedy .* so titles containing em-dashes still resolve to the last **STATUS**
    const m = line.match(/\*\*(R-\d+)\*\*.*\*\*(\w+)\*\*/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/** Extract rows from the RTM markdown table.
 *  Returns Map<rid, { status, codePaths: string[] }>
 */
function parseTraceability(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    // Table row: | R-01 | title | STATUS | code cell | tests |
    const cols = line.split('|').map(c => c.trim());
    if (cols.length < 5) continue;
    const ridCol    = cols[1];
    const statusCol = cols[3];
    const codeCol   = cols[4];
    if (!/^R-\d+$/.test(ridCol)) continue;

    // Extract backtick-quoted paths from the code cell
    const paths = [];
    const backtickRe = /`([^`]+)`/g;
    let bm;
    while ((bm = backtickRe.exec(codeCol)) !== null) {
      const tok = bm[1];
      // Only treat tokens containing path separators as file paths
      if (tok.includes('/') || tok.includes('\\')) {
        paths.push(tok);
      }
    }

    map.set(ridCol, { status: statusCol, codePaths: paths });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const requirementsPath = resolve(REPO_ROOT, 'requirements', 'REQUIREMENTS.md');
const traceabilityPath = resolve(REPO_ROOT, 'requirements', 'TRACEABILITY.md');

if (!existsSync(requirementsPath)) {
  console.error('FAIL: REQUIREMENTS.md not found at ' + requirementsPath);
  process.exit(1);
}
if (!existsSync(traceabilityPath)) {
  console.error('FAIL: TRACEABILITY.md not found at ' + traceabilityPath);
  process.exit(1);
}

const reqText  = readFileSync(requirementsPath,  'utf8');
const tracText = readFileSync(traceabilityPath,  'utf8');

const reqMap  = parseRequirements(reqText);
const tracMap = parseTraceability(tracText);

const failures = [];

// 1. Every R-ID in REQUIREMENTS must appear in TRACEABILITY with matching status
for (const [rid, reqStatus] of reqMap) {
  if (!tracMap.has(rid)) {
    failures.push(rid + ': present in REQUIREMENTS.md but MISSING from TRACEABILITY.md');
    continue;
  }
  const { status: tracStatus } = tracMap.get(rid);
  if (reqStatus !== tracStatus) {
    failures.push(
      rid + ': status mismatch — REQUIREMENTS says "' + reqStatus + '", TRACEABILITY says "' + tracStatus + '"'
    );
  }
}

// 2. Every R-ID in TRACEABILITY must appear in REQUIREMENTS
for (const rid of tracMap.keys()) {
  if (!reqMap.has(rid)) {
    failures.push(rid + ': present in TRACEABILITY.md but MISSING from REQUIREMENTS.md');
  }
}

// 3. Every Code file path in TRACEABILITY must exist on disk
const missingFiles = [];
for (const [rid, { codePaths }] of tracMap) {
  for (const rawPath of codePaths) {
    const normalized = rawPath.replace(/\\/g, '/');
    // Try repo-relative (e.g. "web/src/...") and web/-prefixed forms
    const candidates = [
      resolve(REPO_ROOT, normalized),
      resolve(REPO_ROOT, 'web', normalized),
    ];
    const found = candidates.some(p => existsSync(p));
    if (!found) {
      missingFiles.push({ rid, path: rawPath });
    }
  }
}

for (const { rid, path } of missingFiles) {
  failures.push(rid + ': Code file not found on disk — "' + path + '"');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (failures.length === 0) {
  const ridCount   = reqMap.size;
  const fileChecks = [...tracMap.values()].reduce((n, { codePaths }) => n + codePaths.length, 0);
  console.log(
    'RTM OK — ' + ridCount + ' R-IDs status-matched, ' + fileChecks + ' Code-file paths verified on disk.'
  );
  process.exit(0);
} else {
  console.error('RTM FAIL — ' + failures.length + ' issue(s):\n');
  for (const f of failures) console.error('  x ' + f);
  process.exit(1);
}
