// prepare.mjs — npm `prepare` entry for web/.
// In the full repo checkout this installs the checked-in git hooks
// (repo-root scripts/setup-hooks.mjs). In builds that only ship web/
// (Vercel's root-directory build) the root script doesn't exist — a
// prepare failure there kills `npm install`, so this wrapper no-ops.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootScript = new URL("../../scripts/setup-hooks.mjs", import.meta.url);
if (existsSync(fileURLToPath(rootScript))) {
  await import(rootScript.href);
}
