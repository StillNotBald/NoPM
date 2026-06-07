// NoPM — verify the RTM (TRACEABILITY.md) status column matches REQUIREMENTS.md.
// Fails (exit 1) on any drift. Run: npm run rtm:verify
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const reqDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "requirements");
const STATUS = /\b(DONE|PARTIAL|TODO|DEFERRED)\b/;

function parseStatuses(txt) {
  const map = new Map();
  for (const line of txt.split("\n")) {
    const id = line.match(/R-(\d{2})\b/);
    if (!id) continue;
    const st = line.match(STATUS);
    if (st) map.set(`R-${id[1]}`, st[1]);
  }
  return map;
}

const reqs = parseStatuses(await readFile(path.join(reqDir, "REQUIREMENTS.md"), "utf8"));
const rtm = parseStatuses(await readFile(path.join(reqDir, "TRACEABILITY.md"), "utf8"));

const problems = [];
for (const [id, status] of reqs) {
  if (!rtm.has(id)) problems.push(`${id}: missing from TRACEABILITY.md`);
  else if (rtm.get(id) !== status)
    problems.push(`${id}: REQUIREMENTS=${status} but TRACEABILITY=${rtm.get(id)}`);
}
for (const id of rtm.keys()) {
  if (!reqs.has(id)) problems.push(`${id}: in TRACEABILITY.md but not REQUIREMENTS.md`);
}

if (problems.length) {
  console.error(`RTM drift (${problems.length}):`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`RTM OK — ${reqs.size} requirements in sync.`);
