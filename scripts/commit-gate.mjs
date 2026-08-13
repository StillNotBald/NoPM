#!/usr/bin/env node
// commit-gate.mjs — leak gate for NoPM (seeded 2026-07-11, boundary audit;
// hashed 2026-08-13 so the gate itself cannot leak what it guards).
//
// Runs from .githooks/pre-commit (staged files) and CI (--all = every tracked
// text file). The confidential token list is stored as SHA-256 digests of
// normalized tokens — the gate can detect them without containing them.
//
// BLOCKS (exit 1):
//   - confidential tokens (names/identifiers that must never enter this
//     public portfolio repo)
//   - secret-class filenames (.env*, *.pem, *.key, credentials*, auth.json)
// WARNS (exit 0):
//   - warn-class tokens (private lineage codenames — fine in private notes,
//     genericize before anything public)
//
// To extend the list: node -e "console.log(require('node:crypto')
//   .createHash('sha256').update('<token lowercase>').digest('hex'))"
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BLOCK_HASHES = new Set([
  '1cf8531a22348eeb2abe9b891c939707aa5abfab759f1f6be7abc4a763968ebc',
  '75095ad3ad3b359e05cfba5ea16c3d2128e83fa591fc452e338375558e266b27',
  'dc07dfa4863c403fb5ba332d087ed5e6d442d529529f6438219e7ad3f66fa574',
  'ff06535ac1029cca2fc2b86ac7355a7b4e0b8d839fc76b51d30833f4e1347ddc',
  '9c2364ba04c712fb921ed288c94cb6b14b85f9d342377d4f007ee4da089779da',
  '42014f276e94d169668a8fa97b7a722aac310f2e9364fd9dff23f33028e63fb7',
  '9f9f145097e3eac27617907c5f831c3433db79b3c6a2da206fbc212453ee8dbf',
  '64c3ffc775a9a3de5a410e24c380832096b95435fd8f05b6ebe0089f553e9185',
  '7942e84ee77ffefd180f42f0c0dfeadcb079a78705e506833eaa6258b85a2668',
  'f2c0313d0f5fff4324264f5f246db17eef33d7f8007251e20c06e707bb006584',
  '8d513f6668754e799a9cc365f18643ff429009401c1502a36f09e5452dc6132d',
]);
const WARN_HASHES = new Set([
  '5cbde28e8c55b1f12675ca3ee4ef1118014b22a1089902024fab04c2656c7583',
]);

// credentials* only in data-file form — a credentials/route.ts API route is code, not a dump.
const SECRET_FILENAMES = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|auth\.json|credentials?([-_.][^/]*)?\.(json|txt|ya?ml|csv))$/i;
const TEXT_EXT = /\.(md|txt|html|json|yml|yaml|csv|ts|tsx|js|mjs|cjs|sql)$/i;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Scan content for hashed-token matches over 1-grams and 2-grams. */
function scan(content) {
  const words = content.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const hits = { block: 0, warn: 0 };
  for (let i = 0; i < words.length; i++) {
    const h1 = sha256(words[i]);
    if (BLOCK_HASHES.has(h1)) hits.block++;
    if (WARN_HASHES.has(h1)) hits.warn++;
    if (i + 1 < words.length) {
      const h2 = sha256(words[i] + ' ' + words[i + 1]);
      if (BLOCK_HASHES.has(h2)) hits.block++;
      if (WARN_HASHES.has(h2)) hits.warn++;
    }
  }
  return hits;
}

const all = process.argv.includes('--all');
const files = execSync(
  all ? 'git ls-files' : 'git diff --cached --name-only --diff-filter=ACM',
  { encoding: 'utf8' },
).split('\n').filter(Boolean);

let blocked = false;

for (const file of files) {
  if (SECRET_FILENAMES.test(file) && !/\.example$|\.template$/i.test(file)) {
    console.error(`✗ commit-gate: secret-class filename: ${file}`);
    blocked = true;
    continue;
  }
  if (!TEXT_EXT.test(file)) continue;

  let content;
  try { content = readFileSync(file, 'utf8'); } catch { continue; }

  const hits = scan(content);
  if (hits.block) {
    console.error(`✗ commit-gate: ${file} contains ${hits.block} confidential token match(es) (hashed blocklist).`);
    blocked = true;
  }
  if (hits.warn) {
    console.warn(`⚠ commit-gate: ${file} contains ${hits.warn} private-codename match(es) — fine privately; genericize before anything public.`);
  }
}

if (blocked) {
  console.error('commit-gate: BLOCKED. Remove the flagged content (or rename the file) and re-stage.');
  process.exit(1);
}
console.log(`✓ commit-gate: ${files.length} ${all ? 'tracked' : 'staged'} file(s) clean.`);
