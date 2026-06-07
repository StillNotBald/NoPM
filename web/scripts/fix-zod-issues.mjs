// One-off: Zod v4 renamed ZodError.errors -> .issues. Rewrite across a dir.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
function walk(d) {
  for (const name of readdirSync(d)) {
    const p = path.join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts")) {
      const c = readFileSync(p, "utf8");
      const n = c.split(".error.errors").join(".error.issues");
      if (n !== c) {
        writeFileSync(p, n);
        console.log("fixed", path.relative(dir, p));
      }
    }
  }
}
walk(dir);
console.log("done");
