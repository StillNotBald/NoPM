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
  '0a5d17d3b19f82f8340d3977609aa9e86b4ad8b9bd71bd9eced9271f1d5b2e4a',
  'd322c3a9837fad6b52f61630ebd14ce83966c93c7d8b8248eb7b7b041c1c643f',
  '5cbde28e8c55b1f12675ca3ee4ef1118014b22a1089902024fab04c2656c7583',
  '1353530fbd7dfe883aca9b1627080286f9efadf707ea70f0749d948de6880c9d',
  'b208e7a56b7069b88b940cbaae4133a74980b62e1fdea56a52c938d317cc43f3',
  '6e20ba3cb9f56063ccb9b516eacaa8d9c348dd90eae251ac5ee1187d3e83c136',
  'cf043203fa9e891d8862e4c6dba23f972d800d6dffd420552f71672b0d248b95',
  '49bf5f6638d20bc7712ac454e4e2193d3af01a88508416bd3f39498ac42152a8',
  '06ef6443d1edce84857630c6e7a4d2e5b254cad6311b214c58cd2656456ee581',
  '40f6e90d96577f8c8ca12e0f9098ad244cc4b423576a74d5dc3a68148c377e35',
  '6303ebfdc96647217186fddfe0e1fb0d9b363d8b94962c31087b5b018ae7c7b5',
  '1d78b370ad96e7a8091888d902360187bdea87ab6a4af003ec63c791894513ec',
  'a9ddffe832944acecef2385c2c909825bec963f62d07eca8cfb4bf323d60fb6a',
  'dfb316701857783dac69a14d1fe3fd60cff21d56e830baf7f0e3871bd73eee39',
  '7a43b0fbabf45824f6c7db88e90e367083787a28ff3d5ab1b50171c5e07f8c69',
  'b6d16b12701e5888774f33adfccc3b72800581b6a7fe89e2c17614947561bd6a',
  'a00f3868f055687c8e83972a1860f3fb6c88548096fbf6d3c3271c62adcfad79',
  '090b2ca2e3faa1d9a4edb98bde0fe14fb0f76273154814d6f460c72b5dfdc305',
  'cbd1a5479e6aecd9aaa13056d0e81e35014857617dcff3bf557bb49d44061cca',
  'a49d155d6fac3486f0bab116f37a557903298fb1009f6aa43c31f71460552b25',
  'f8d5b7b6d52f258591932f46b696dca7c6fae60caa277bda3990806365d13871',
  '9685c81b76accc50694909aed78fa64a4cfa14a92c2f347785ef06b7840815a7',
  '7bd6bd0c779d022275b3219edbcd457c9be42e0c6b3778e790cd77f5c12cc8b7',
  '8bc54f79a169eabdba93702d6bb0d54b18f0fcedd008477f99643d26124230be',
  '08001e889a7735cd838d16d623df34b05f2b7f31bf75c5616211b6f9f6692abe',
  '93f2d652b76c1ecd31c5dcc24f3e43dba3cbed65090edd952069d6056702abc4',
  'eadba710424a7ccf76ee3a5b175ea916c5095c23e0c9eb73cd06e0bd391a88de',
  'a005bf305a8704092c92e47da51df192683a9bf7a1c5ca10dbbf7347a88fa109',
  'b3c60e46e2433217e892560674224f9a6d08faef0ac65b5d9f6572ff06630406',
  '9f0aa91fa988413abe10ea8f79512de6ae3482ac66594832574ca566abb9f3ec',
  '6cfeb2b7d2d4ab1d46fdaa3a7c67745e1f97daaf336cd1afe85a8499a3d7b31f',
  '044359cdd53d600448cfea32bd9f05a7697e05ce3eecbe1d2f510ad2ad29587f',
  'c2dec5a4a4142617a00dffc4329a4c4fb1308a08160048814370169878fe8715',
  '913e576f6588eac6ab3078ec255890e2a06abf399c237a60431ac6d4fe47833f',
  'd1f8b80df0f04f9fb9d2301f8811562cc16010891492393f88ec8c3a4f2890a5',
  '6313908bd9a2c9ff2c50be542b590609380102daef54866737bfec7fcd7e2381',
  '551a53e1f74944b5ccff35d3ef6d6ffb73553faa006292e793c2c0c8796b8b20',
  'ff3715a331cd6191315dd88d9ebdaca8c2c1139066727713a4a6392814d8b0da',
  'abe87f4b37509e7b1c2004a82b2214ce468082d1dedde112d85a615cfe913d28',
  '7d26250c75f9f5e5dcc5d6db1a9dd640932c9e470cfa97199d8867d9bd76ef64',
  'd515769b5a14ae6def72cfd6f10c537ba43754d15a5a7341e8d55a185331125e',
  'ebfbc38c1d1a932c34a0940d3af27a3d13352f1603aebbd2397e688741538894',
  '9bfae455883ed2eae3c7bd2f4acade65d940805e59d4582db726c2e9fa88d6b4',
  '1253907ee815c8888aab37e3a820c0ee714c56db4c511eec594ca01ef44d56a6',
  '777ecb482d38c6aacf76d22ecc68d2b6418fe5bd6ba9df77ecd4a22cc5e613ee',
  'efd39df0016bd7bff535b2de3d7ab42ae0f969de86d7dabf743e12a07d9a431d',
  'f03dac477020a6ea6e088af3e3af883a4051e2fb6bde832b03a1b53c3a5342db',
  '92ee29b9b9b7a627cd00ad5083735e95fefb4c58c2726f0c939bbd87fa1b3e85',
  '71b41d6dd48dc58eba8f5cf9edf30fef6597fdf285a521bb8fcbad4b3d50887d',
  'ecfef185c53fa64b82fab182a90bf6340239174140fbe56c3a55faacf9a8c118',
  '1d65dc41fda3f8cf9262e9d92c9babffde43f0b2d83aed601b971efccde008c4',
  '2edf6d302e659b119f2e8d882a0ba62e3b29ba225d399215a4d9703d2c005183',
  '613ad991bf2b5079e8180bf1719fbd8e5c92d5991fad484345230514afff685c',
  '556d1f14c80f008eb61334df7417e0adb53464a22552ce44913c435fd39f3fe5',
  'd94077a84b77f60277805960c10c76557daa016f599a6aa577739d78881cda6d',
  '09cf980b5ff304ac11b7f6d2c5c263da2a867425798ef5cc5d2ebcf55c4fcd23',
]);
const WARN_HASHES = new Set([
  '5cbde28e8c55b1f12675ca3ee4ef1118014b22a1089902024fab04c2656c7583',
]);
// Model-family names: blocked as prose (internal build-harness detail), allowed
// only inside a provider model id (`claude-<family>-<version>`), which the BYOK
// assistant's model picker ships as product data.
const MODEL_HASHES = new Set([
  'c9ad8f2cc1294afa0ef22fc2c019ff7243cdd272b2147ddca3f34c5036b05768',
  'e12ce8285efc67c6d93d3a122e2589ed95089bcbb775ba5634d94e2b8385db07',
  '5a5110ebe1544b31e6d4207a419bc1deb148735f89ae984ff0a2ab809b51f1df',
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
    if (MODEL_HASHES.has(h1) && words[i - 1] !== 'claude') hits.block++;
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
