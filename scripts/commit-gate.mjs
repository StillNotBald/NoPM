#!/usr/bin/env node
// commit-gate.mjs — leak gate for NoPM (seeded 2026-07-11, boundary audit).
// Runs via the global PreToolUse pre-commit hook. Scans STAGED files only.
//
// BLOCKS (exit 1):
//   - real stakeholder names (this is the public-facing portfolio repo)
//   - client-identifying domain tokens (engagement identity must never enter)
//   - secret-class filenames (.env*, *.pem, *.key, credentials*, auth.json)
// WARNS (exit 0):
//   - the client codename in prose (allowed as private lineage note, but keep
//     it out of anything that could ship — genericize before any public cut)
//   - edits under docs/research/ (contains client-app internals; PRIVATE —
//     must be scrubbed/excluded before this repo is ever made public)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BLOCK_TOKENS = [
  /[redacted]/, /[redacted]/, /[redacted]/, /[redacted]/, /[redacted]/,
  /[redacted]/, /\b[redacted]\b/i,
  /[redacted]/, /\b[redacted]\b/i, /[redacted]/i,
];
const WARN_TOKENS = [/[redacted]/];
const SECRET_FILENAMES = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|credentials.*|auth\.json)$/i;
const TEXT_EXT = /\.(md|txt|html|json|yml|yaml|csv|ts|tsx|js|mjs|cjs|sql)$/i;

const staged = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' })
  .split('\n').filter(Boolean);

let blocked = false;

for (const file of staged) {
  if (SECRET_FILENAMES.test(file) && !/\.example$|\.template$/i.test(file)) {
    console.error(`✗ commit-gate: secret-class filename staged: ${file}`);
    blocked = true;
    continue;
  }
  if (file.startsWith('docs/research/')) {
    console.warn(`⚠ commit-gate: ${file} is under docs/research/ — PRIVATE folder (client-derived internals); scrub before any public release.`);
  }
  if (!TEXT_EXT.test(file) || file.endsWith('commit-gate.mjs')) continue;

  let content;
  try { content = readFileSync(file, 'utf8'); } catch { continue; }

  for (const pat of BLOCK_TOKENS) {
    if (pat.test(content)) {
      console.error(`✗ commit-gate: forbidden token ${pat} in ${file}`);
      blocked = true;
    }
  }
  for (const pat of WARN_TOKENS) {
    if (pat.test(content)) {
      console.warn(`⚠ commit-gate: client codename ${pat} in ${file} — fine privately; genericize before anything public.`);
    }
  }
}

if (blocked) {
  console.error('commit-gate: BLOCKED. Remove the flagged content (or rename the file) and re-stage.');
  process.exit(1);
}
console.log(`✓ commit-gate: ${staged.length} staged file(s) clean.`);
